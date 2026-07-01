export default {
    async fetch(request, env) {
      try {
        const url = new URL(request.url);
        const path = url.pathname;
  
        // Handle preflight requests
        if (request.method === 'OPTIONS') {
          return new Response(null, {
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            }
          });
        }
  
        // PWA routes
        if (path === '/manifest.webmanifest') {
          return serveManifest(request);
        }

        if (path === '/sw.js') {
          return serveServiceWorker(request);
        }

        if (path === '/icon.svg') {
          return serveIconSvg(request);
        }

        // Protected/public share link routes: /s/<shareId>, /s/<shareId>/download, /s/<shareId>/raw/<fileId>
        if (path.startsWith('/s/')) {
          return handleShareRoute(request, env, path);
        }

        // Release download route: /release/<repoId>/<releaseId> or /release/<repoId>/<releaseId>/<fileId>
        if (path.startsWith('/release/')) {
          return handleReleaseRoute(request, env, path);
        }

        // Redirect repo/*.git ke repo/* (tanpa .git) untuk public view
        if (path.match(/^\/repo\/[^\/]+\.git$/) && !path.includes('/info/refs') && !path.includes('/git-upload-pack')) {
          const repoId = path.split('/')[2].replace('.git', '');
          return new Response('', {
            status: 301,
            headers: { 'Location': `/repo/${repoId}` }
          });
        }

        // Pretty Git URL lama: /git/<repoId>/<repo-name>.git
        // Tetap disupport untuk kompatibilitas, tapi URL baru sekarang root: /nama-repo.git
        if (path.match(/^\/git\/[^\/]+\/[^\/]+\.git$/) && !path.includes('/info/refs') && !path.includes('/git-upload-pack')) {
          const repoId = path.split('/')[2];
          return new Response('', {
            status: 301,
            headers: { 'Location': `/repo/${repoId}` }
          });
        }

        // Git URL gaya GitHub: /nama-repo.git
        // Jika dibuka di browser, arahkan ke halaman repo. Jika dipakai git clone,
        // request /info/refs dan /git-upload-pack akan ditangani oleh Git protocol.
        if (path.match(/^\/[^\/]+\.git$/) && !path.includes('/info/refs') && !path.includes('/git-upload-pack')) {
          const slug = decodeURIComponent(path.slice(1).replace(/\.git$/i, ''));
          const found = await findRepoBySlug(env, slug);
          if (!found) return new Response('Repository not found', { status: 404 });
          return new Response('', {
            status: 301,
            headers: { 'Location': publicRepoPathForRepo(found.repoId, found.repo) }
          });
        }

  
        // Simple routing
        if (path === '/login' || path === '/api/auth/login') {
          return handleLogin(request, env);
        }
  
        if (path === '/api/auth/logout') {
          return handleLogout(request, env);
        }
  
        // Upload file handler
        if (path === '/api/upload' && request.method === 'POST') {
          return handleFileUpload(request, env);
        }
  
        // Import from URL handler - DIPINDAHKAN ke API handler
        if (path === '/api/import-from-url' && request.method === 'POST') {
          const authResult = await authenticate(request, env);
          if (!authResult.authenticated) {
            return jsonResponse({ error: 'Unauthorized' }, 401);
          }
          return handleImportFromURL(request, env, authResult.user);
        }
  
        // Public routes
        if (path.startsWith('/repo/') && !path.includes('/info/refs') && !path.includes('/git-upload-pack')) {
          return handlePublicRepo(request, env, path);
        }
  
        if (path.startsWith('/raw/')) {
          return handleRawFile(request, env, path);
        }
  
        if (path.startsWith('/download/')) {
          return handleDownloadRepo(request, env, path);
        }
  
        // Git protocol
        if (path.includes('/info/refs') || path.includes('/git-upload-pack')) {
          return handleGitProtocol(request, env, path);
        }
  
        // API routes
        if (path.startsWith('/api/')) {
          const authResult = await authenticate(request, env);
          const method = request.method;
          
          // Only write operations need auth
          if ((method === 'POST' || method === 'PUT' || method === 'DELETE') && !authResult.authenticated) {
            return jsonResponse({ error: 'Unauthorized' }, 401);
          }
          
          return handleAPI(request, env, path, authResult.user);
        }
  
        // Public repo URL gaya GitHub: /nama-repo
        // Contoh: https://domain.workers.dev/cob
        // Ini membuat Copy Public lebih rapi dan tidak lagi memakai /repo/<id>.
        if (path.match(/^\/[^\/]+$/)) {
          const slug = decodeURIComponent(path.slice(1));
          const found = await findRepoBySlug(env, slug);
          if (found) {
            return handlePublicRepo(request, env, `/repo/${found.repoId}`);
          }
        }

        // Homepage
        const authResult = await authenticate(request, env);
        if (path === '/' && !authResult.authenticated) {
          return servePublicHomepage(env);
        }
  
        // Dashboard for logged-in users
        return serveHTML(env, authResult.authenticated, authResult.user);
  
      } catch (error) {
        console.error('Global error:', error);
        return new Response('Internal Server Error', { 
          status: 500,
          headers: { 
            'Content-Type': 'text/plain',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }
  };
  
  // ============================================
  // R2 HELPER FUNCTIONS
  // ============================================
  
  // R2 Get - returns parsed JSON or null
  async function r2Get(env, key) {
    try {
      const object = await env.KODE_STORAGE.get(key);
      if (!object) return null;
      const text = await object.text();
      return text;
    } catch (error) {
      console.error('R2 Get error:', error);
      return null;
    }
  }
  
  // R2 Get Object - returns raw R2 object for binary files
  async function r2GetObject(env, key) {
    try {
      const object = await env.KODE_STORAGE.get(key);
      return object || null;
    } catch (error) {
      console.error('R2 Get Object error:', error);
      return null;
    }
  }

  // R2 Put - stores string/binary data
  async function r2Put(env, key, data, options = {}) {
    try {
      await env.KODE_STORAGE.put(key, data, options);
      return true;
    } catch (error) {
      console.error('R2 Put error:', error);
      return false;
    }
  }
  
  // R2 Delete - deletes object
  async function r2Delete(env, key) {
    try {
      await env.KODE_STORAGE.delete(key);
      return true;
    } catch (error) {
      console.error('R2 Delete error:', error);
      return false;
    }
  }
  
  // R2 List - lists objects with prefix
  async function r2List(env, prefix) {
    try {
      const listed = await env.KODE_STORAGE.list({ prefix });
      return listed.objects || [];
    } catch (error) {
      console.error('R2 List error:', error);
      return [];
    }
  }
  
  // ============================================
  // END R2 HELPER FUNCTIONS
  // ============================================
  
  // Helper function untuk JSON responses dengan CORS
  function jsonResponse(data, status = 200, headers = {}) {
    const responseHeaders = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      ...headers
    };
    
    return new Response(JSON.stringify(data), {
      status,
      headers: responseHeaders
    });
  }
  
  // Authentication function
  async function authenticate(request, env) {
    try {
      const cookieHeader = request.headers.get('Cookie');
      if (cookieHeader && cookieHeader.includes('session=')) {
        const sessionMatch = cookieHeader.match(/session=([^;]+)/);
        if (sessionMatch) {
          const sessionId = sessionMatch[1];
          const sessionData = await r2Get(env, `session:${sessionId}`);
          if (sessionData) {
            const session = JSON.parse(sessionData);
            if (session.expires > Date.now()) {
              return { authenticated: true, user: session.user };
            }
          }
        }
      }
      
      return { authenticated: false, user: null };
    } catch (error) {
      console.error('Auth error:', error);
      return { authenticated: false, user: null };
    }
  }

  // ============================================
  // V4 PRO HELPERS: SECURITY, VISIBILITY, MIME, ICONS
  // ============================================

  const V4_VERSION = 'CodeHub V5.4 Final Pro';

  function getAdminUser(env) {
    return String(env.ADMIN_USER || 'admin');
  }

  function getAdminPass(env) {
    return String(env.ADMIN_PASS || 'admin123');
  }

  function normalizeVisibility(repo) {
    if (!repo) return 'public';
    if (repo.visibility === 'private' || repo.private === true) return 'private';
    if (repo.visibility === 'unlisted') return 'unlisted';
    return 'public';
  }

  function isRepoPublic(repo) {
    return normalizeVisibility(repo) === 'public' || normalizeVisibility(repo) === 'unlisted';
  }

  function canAccessRepo(repo, user) {
    if (isRepoPublic(repo)) return true;
    return !!(user && (user.role === 'admin' || repo.owner === user.id));
  }

  async function loadRepo(env, repoId) {
    const repoData = await r2Get(env, `repo:${repoId}`);
    if (!repoData) return null;
    const repo = JSON.parse(repoData);
    if (!repo.files) repo.files = [];
    if (!repo.visibility) repo.visibility = 'public';
    return ensureRepoFinalFields(repo);
  }

  async function findRepoBySlug(env, slugOrName) {
    const targetSlug = slugifyRepoName(slugOrName || '');
    if (!targetSlug) return null;
    const repoObjects = await r2List(env, 'repo:');
    let fallback = null;
    for (const obj of repoObjects) {
      const repoId = obj.key.replace('repo:', '');
      const repo = await loadRepo(env, repoId);
      if (!repo) continue;
      const repoSlug = slugifyRepoName(repo.name || repoId);
      if (repoSlug === targetSlug) {
        const found = { repoId, repo };
        // Jika ada duplikat nama, prioritaskan repo public agar git clone publik tetap berhasil.
        if (isRepoPublic(repo)) return found;
        if (!fallback) fallback = found;
      }
    }
    return fallback;
  }

  function repoToClient(request, repoId, repo) {
    const origin = request ? new URL(request.url).origin : '';
    const fileCount = Array.isArray(repo.files) ? repo.files.length : 0;
    const gitPath = gitClonePathForRepo(repoId, repo);
    return {
      id: repoId,
      publicUrl: publicRepoPathForRepo(repoId, repo),
      gitUrl: gitPath,
      absolutePublicUrl: origin ? `${origin}${publicRepoPathForRepo(repoId, repo)}` : publicRepoPathForRepo(repoId, repo),
      absoluteGitUrl: origin ? `${origin}${gitPath}` : gitPath,
      visibility: normalizeVisibility(repo),
      fileCount,
      ...repo
    };
  }

  function sanitizePath(input, fallback = 'file.txt') {
    const cleaned = String(input || fallback)
      .replace(/\\/g, '/')
      .split('/')
      .map(part => part.replace(/[\x00-\x1F<>:"|?*]+/g, '_').trim())
      .filter(part => part && part !== '.' && part !== '..')
      .join('/');
    return cleaned || fallback;
  }

  function fileExt(filename) {
    const clean = String(filename || '').split('?')[0].split('#')[0];
    const last = clean.split('/').pop() || '';
    const dot = last.lastIndexOf('.');
    return dot >= 0 ? last.slice(dot + 1).toLowerCase() : '';
  }

  function getMimeType(filename) {
    const ext = fileExt(filename);
    const map = {
      js:'text/javascript', mjs:'text/javascript', jsx:'text/javascript', ts:'text/typescript', tsx:'text/typescript',
      html:'text/html', htm:'text/html', css:'text/css', json:'application/json', txt:'text/plain', md:'text/markdown', csv:'text/csv', xml:'application/xml', svg:'image/svg+xml',
      png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', avif:'image/avif', ico:'image/x-icon',
      pdf:'application/pdf', zip:'application/zip', rar:'application/vnd.rar', '7z':'application/x-7z-compressed', tar:'application/x-tar', gz:'application/gzip',
      mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg', flac:'audio/flac', m4a:'audio/mp4',
      mp4:'video/mp4', webm:'video/webm', mov:'video/quicktime', mkv:'video/x-matroska',
      pdf:'application/pdf', doc:'application/msword', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    };
    return map[ext] || 'text/plain; charset=utf-8';
  }

  function getLanguageFromName(filename) {
    const ext = fileExt(filename);
    const map = {
      js:'javascript', mjs:'javascript', jsx:'javascript', ts:'typescript', tsx:'typescript',
      py:'python', html:'html', htm:'html', css:'css', scss:'scss', sass:'sass',
      java:'java', c:'c', cpp:'cpp', cc:'cpp', h:'c', hpp:'cpp', go:'go', rs:'rust', rb:'ruby', php:'php',
      json:'json', xml:'xml', yaml:'yaml', yml:'yaml', toml:'toml', ini:'ini', sql:'sql', sh:'bash', bash:'bash',
      md:'markdown', txt:'text', csv:'csv', svg:'svg', png:'image', jpg:'image', jpeg:'image', gif:'image', webp:'image', pdf:'pdf', zip:'archive'
    };
    return map[ext] || 'text';
  }

  function getFileIconFromName(filename, language = '') {
    const lang = language || getLanguageFromName(filename);
    const map = {
      javascript:'📜', typescript:'📘', python:'🐍', html:'🌐', css:'🎨', scss:'🎨', sass:'🎨',
      java:'☕', c:'⚙️', cpp:'⚙️', go:'🐹', rust:'🦀', ruby:'💎', php:'🐘', bash:'💻', sql:'🗃️',
      json:'📋', xml:'📄', yaml:'⚙️', toml:'⚙️', ini:'⚙️', markdown:'📝', text:'📝', csv:'📊',
      image:'🖼️', svg:'🎨', pdf:'📕', archive:'📦', audio:'🎵', video:'🎬'
    };
    return map[lang] || '📄';
  }

  function isPreviewableImage(name) { return ['png','jpg','jpeg','gif','webp','svg','avif'].includes(fileExt(name)); }
  function isPreviewableVideo(name) { return ['mp4','webm','mov'].includes(fileExt(name)); }
  function isPreviewableAudio(name) { return ['mp3','wav','ogg','flac','m4a'].includes(fileExt(name)); }

  function shouldForceDownloadRaw(file, mimeType = '', filename = '') {
    const ext = fileExt(filename || (file && file.name) || '');
    const mime = String(mimeType || (file && file.mimeType) || getMimeType(filename)).toLowerCase().split(';')[0].trim();
    const forceDownloadExts = new Set([
      'zip','rar','7z','tar','gz','bz2','xz',
      'apk','ipa','exe','msi','dmg','pkg','deb','rpm',
      'jar','war','ear','iso','img','bin','dll','so','dylib',
      'wasm','class','aab','obb'
    ]);
    if (forceDownloadExts.has(ext)) return true;
    if (mime === 'application/zip' || mime === 'application/x-zip-compressed') return true;
    if (mime.includes('compressed') || mime.includes('archive')) return true;
    if (mime === 'application/octet-stream' && !isPreviewableImage(filename) && !isPreviewableVideo(filename) && !isPreviewableAudio(filename) && ext !== 'pdf') return true;
    return false;
  }

  function isTextMime(mimeType, filename = '') {
    const mime = String(mimeType || getMimeType(filename)).toLowerCase();
    const ext = fileExt(filename);
    return mime.startsWith('text/') || ['application/json','application/xml','image/svg+xml','application/javascript'].includes(mime) || ['js','mjs','ts','tsx','jsx','json','xml','svg','html','htm','css','md','txt','csv','yaml','yml','toml','ini','sh','py','php','rb','go','rs','java','c','cpp','h','hpp','sql'].includes(ext);
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(String(base64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  const BINARY_METADATA_BACKUP_LIMIT = 8 * 1024 * 1024;

  function attachBinaryBackup(fileData, bytes) {
    // Cloudflare R2 object is still the main storage. This small/medium base64 backup
    // prevents ZIP/APK/image files from becoming empty if a legacy object key is missing
    // or if an older deployment wrote incomplete binary metadata.
    if (!fileData || !bytes || bytes.length === 0) return;
    if (bytes.length <= BINARY_METADATA_BACKUP_LIMIT) {
      fileData.contentBase64 = bytesToBase64(bytes);
      fileData.backupEncoding = 'base64';
    }
  }

  function getBase64BackupBytes(file) {
    if (!file) return null;
    const candidates = [file.contentBase64, file.backupBase64, file.base64Content, file.dataBase64, file.binaryBase64];
    for (const value of candidates) {
      if (typeof value === 'string' && value.length > 0) return base64ToBytes(value);
    }
    if (file.encoding === 'base64' && typeof file.content === 'string') return base64ToBytes(file.content || '');
    return null;
  }

  function fileContentBytes(file) {
    // Legacy sync helper: only reads content already embedded in repo metadata.
    if (file && file.encoding === 'base64') return base64ToBytes(file.content || '');
    return textBytes(file ? (file.content || '') : '');
  }

  function possibleFileStorageKeys(file) {
    const keys = [];
    if (!file) return keys;
    if (file.storageKey) keys.push(file.storageKey);
    if (file.r2Key) keys.push(file.r2Key);
    if (file.objectKey) keys.push(file.objectKey);
    if (file.key && !String(file.key).startsWith('repo:')) keys.push(file.key);
    if (file.id) {
      keys.push(`file:${file.id}`);
      keys.push(`files/${file.id}`);
      keys.push(`objects/${file.id}`);
    }
    return [...new Set(keys.filter(Boolean))];
  }

  async function getFileBytes(env, file) {
    // Single source of truth for Raw, Download File, ZIP repo, Release ZIP, and Git clone.
    // Priority: R2 object bytes -> base64 backup -> legacy embedded text/base64.
    if (!file) return new Uint8Array(0);

    const expectedSize = Number(file.size || 0);

    if (file.encoding === 'r2') {
      for (const key of possibleFileStorageKeys(file)) {
        const object = await r2GetObject(env, key);
        if (object) {
          const bytes = new Uint8Array(await object.arrayBuffer());
          if (bytes.length > 0 || expectedSize === 0) return bytes;
        }
      }
      const backupBytes = getBase64BackupBytes(file);
      if (backupBytes) return backupBytes;
      if (expectedSize > 0) throw new Error(`Stored binary object missing or empty for ${file.name || file.id || 'file'}. Please re-upload this file.`);
      return new Uint8Array(0);
    }

    const backupBytes = getBase64BackupBytes(file);
    if (backupBytes && (file.encoding === 'base64' || file.isText === false)) return backupBytes;

    if (typeof file.content === 'string' && file.content.length > 0) {
      return textBytes(file.content);
    }

    for (const key of possibleFileStorageKeys(file)) {
      const object = await r2GetObject(env, key);
      if (object) {
        const bytes = new Uint8Array(await object.arrayBuffer());
        if (bytes.length > 0 || expectedSize === 0) return bytes;
      }
    }

    if (backupBytes) return backupBytes;
    if (file.isText === false && expectedSize > 0) throw new Error(`Stored binary object missing or empty for ${file.name || file.id || 'file'}. Please re-upload this file.`);
    return textBytes(file.content || '');
  }

  function storageKeyForFile(fileId) {
    return `file:${fileId}`;
  }

  async function deleteStoredFileObject(env, file) {
    for (const key of possibleFileStorageKeys(file)) {
      if (key && !String(key).startsWith('repo:')) await r2Delete(env, key);
    }
  }

  function fileContentForTextArchive(file) {
    if (file && (file.encoding === 'base64' || file.encoding === 'r2' || file.isText === false)) return `[Binary file: ${file.name || 'file'} • ${file.mimeType || getMimeType(file.name || '')} • ${file.size || 0} bytes]\n`;
    return file ? (file.content || '') : '';
  }

  async function findRepoByFile(env, fileId) {
    const repoObjects = await r2List(env, 'repo:');
    for (const obj of repoObjects) {
      const repoId = obj.key.replace('repo:', '');
      const repo = await loadRepo(env, repoId);
      if (!repo || !repo.files) continue;
      const file = repo.files.find(f => f.id === fileId);
      if (file) return { repoId, repo, file };
    }
    return null;
  }



  // ============================================
  // V5.3 FINAL PRO HELPERS: RELEASE, STATS, SHARE, TRASH, HISTORY, SCAN
  // ============================================

  function nowIso() { return new Date().toISOString(); }

  function ensureRepoFinalFields(repo) {
    if (!repo) return repo;
    repo.files = Array.isArray(repo.files) ? repo.files : [];
    repo.releases = Array.isArray(repo.releases) ? repo.releases : [];
    repo.shares = Array.isArray(repo.shares) ? repo.shares : [];
    repo.trashFiles = Array.isArray(repo.trashFiles) ? repo.trashFiles : [];
    repo.stats = repo.stats || {};
    repo.stats.views = Number(repo.stats.views || 0);
    repo.stats.rawViews = Number(repo.stats.rawViews || 0);
    repo.stats.fileDownloads = Number(repo.stats.fileDownloads || 0);
    repo.stats.zipDownloads = Number(repo.stats.zipDownloads || 0);
    repo.stats.gitClones = Number(repo.stats.gitClones || 0);
    repo.stats.releaseDownloads = Number(repo.stats.releaseDownloads || 0);
    repo.stats.shareHits = Number(repo.stats.shareHits || 0);
    repo.visibility = normalizeVisibility(repo);
    return repo;
  }

  async function saveRepo(env, repoId, repo) {
    ensureRepoFinalFields(repo);
    repo.updated = nowIso();
    await r2Put(env, `repo:${repoId}`, JSON.stringify(repo));
  }

  function normalizeStringList(value) {
    if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
    return String(value || '').split(/[\n,]/).map(v => v.trim()).filter(Boolean);
  }

  function scanTextSecrets(name, content) {
    const text = String(content || '');
    const warnings = [];
    const checks = [
      [/-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/i, 'Private key terdeteksi'],
      [/(api[_-]?key|apikey|secret|token|password|passwd|pwd)\s*[:=]\s*["']?[A-Za-z0-9_\-\.\/+=]{12,}/i, 'Kemungkinan API key/token/password'],
      [/AKIA[0-9A-Z]{16}/, 'Kemungkinan AWS access key'],
      [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Kemungkinan Slack token'],
      [/gh[pousr]_[A-Za-z0-9_]{20,}/, 'Kemungkinan GitHub token'],
      [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'Kemungkinan JWT token'],
      [/cloudflare.*(api|token|key)/i, 'Kemungkinan credential Cloudflare'],
      [/^\s*[A-Z0-9_]{3,}\s*=\s*.+$/m, 'File terlihat seperti ENV/config rahasia']
    ];
    for (const [re, msg] of checks) if (re.test(text)) warnings.push(msg);
    if (/\.env(\.|$)/i.test(String(name || ''))) warnings.push('Nama file .env sebaiknya jangan public');
    return [...new Set(warnings)].slice(0, 6);
  }

  function createVersionSnapshot(file) {
    if (!file || file.isText === false || file.encoding === 'r2' || file.encoding === 'base64') return null;
    return {
      id: generateId(),
      name: file.name,
      content: file.content || '',
      language: file.language || getLanguageFromName(file.name || ''),
      mimeType: file.mimeType || getMimeType(file.name || ''),
      size: file.size || String(file.content || '').length,
      created: nowIso()
    };
  }

  function pushFileVersion(file) {
    const snap = createVersionSnapshot(file);
    if (!snap) return;
    file.versions = Array.isArray(file.versions) ? file.versions : [];
    file.versions.unshift(snap);
    file.versions = file.versions.slice(0, 20);
  }

  async function incrementRepoStat(env, repoId, repo, statName, amount = 1) {
    try {
      ensureRepoFinalFields(repo);
      repo.stats[statName] = Number(repo.stats[statName] || 0) + amount;
      await r2Put(env, `repo:${repoId}`, JSON.stringify(repo));
    } catch (e) {
      console.warn('Stats update failed:', e.message);
    }
  }

  async function incrementFileStat(env, repoId, repo, fileId, statName, amount = 1) {
    try {
      ensureRepoFinalFields(repo);
      const file = (repo.files || []).find(f => f.id === fileId);
      if (file) {
        file.stats = file.stats || {};
        file.stats[statName] = Number(file.stats[statName] || 0) + amount;
      }
      if (statName === 'downloads') repo.stats.fileDownloads = Number(repo.stats.fileDownloads || 0) + amount;
      if (statName === 'views') repo.stats.rawViews = Number(repo.stats.rawViews || 0) + amount;
      await r2Put(env, `repo:${repoId}`, JSON.stringify(repo));
    } catch (e) {
      console.warn('File stats update failed:', e.message);
    }
  }

  function publicRepoSummary(repoId, repo) {
    ensureRepoFinalFields(repo);
    return {
      id: repoId,
      name: repo.name,
      description: repo.description || '',
      visibility: normalizeVisibility(repo),
      created: repo.created,
      updated: repo.updated,
      stats: repo.stats,
      files: (repo.files || []).map(f => ({ id: f.id, name: f.name, language: f.language, size: f.size, mimeType: f.mimeType, isText: f.isText, stats: f.stats || {} })),
      releases: (repo.releases || []).map(r => ({ id: r.id, version: r.version, title: r.title, notes: r.notes, fileIds: r.fileIds || [], downloads: r.downloads || 0, created: r.created }))
    };
  }

  async function findShare(env, shareId) {
    const repoObjects = await r2List(env, 'repo:');
    for (const obj of repoObjects) {
      const repoId = obj.key.replace('repo:', '');
      const repo = ensureRepoFinalFields(await loadRepo(env, repoId));
      if (!repo) continue;
      const share = (repo.shares || []).find(s => s.id === shareId);
      if (share) return { repoId, repo, share };
    }
    return null;
  }

  function checkShareAccess(share, url) {
    if (!share) return { ok: false, reason: 'Share link tidak ditemukan' };
    if (share.expiresAt && Date.now() > Date.parse(share.expiresAt)) return { ok: false, reason: 'Share link sudah expired' };
    if (share.maxDownloads && Number(share.downloads || 0) >= Number(share.maxDownloads)) return { ok: false, reason: 'Limit download share sudah habis' };
    if (share.password) {
      const pass = url.searchParams.get('p') || url.searchParams.get('password') || '';
      if (pass !== String(share.password)) return { ok: false, reason: 'password_required' };
    }
    return { ok: true };
  }

  function passwordSharePage(shareId, reason = '') {
    const msg = reason && reason !== 'password_required' ? `<p class="err">${escapeHtml(reason)}</p>` : '';
    return new Response(`<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>🔐 Share Protected</title><style>${sharedV4Css()}</style></head><body><main class="wrap"><section class="hero"><div><div class="pill">🔐 Protected Share</div><h1>Masukkan Password</h1><p>Link ini diproteksi password.</p>${msg}<div class="linkbox"><input id="p" type="password" placeholder="Password"><button onclick="go()">🚀 Buka</button></div></div></section></main><script>function go(){var p=document.getElementById('p').value;location.href='/s/${shareId}?p='+encodeURIComponent(p)}</script></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  async function touchShare(env, repoId, repo, share, kind = 'hits') {
    ensureRepoFinalFields(repo);
    share.downloads = Number(share.downloads || 0) + (kind === 'download' ? 1 : 0);
    share.hits = Number(share.hits || 0) + 1;
    share.lastAccessed = nowIso();
    repo.stats.shareHits = Number(repo.stats.shareHits || 0) + 1;
    await r2Put(env, `repo:${repoId}`, JSON.stringify(repo));
  }

  async function handleShareRoute(request, env, path) {
    const url = new URL(request.url);
    const parts = path.split('/').filter(Boolean);
    const shareId = parts[1];
    const found = await findShare(env, shareId);
    if (!found) return new Response('Share link not found', { status: 404 });
    const { repoId, repo, share } = found;
    const access = checkShareAccess(share, url);
    if (!access.ok) {
      if (access.reason === 'password_required') return passwordSharePage(shareId);
      return passwordSharePage(shareId, access.reason);
    }
    await touchShare(env, repoId, repo, share, parts[2] === 'download' || parts[2] === 'raw' ? 'download' : 'view');

    if (parts[2] === 'download') {
      const zipBytes = await createZipArchive(env, repo);
      return new Response(zipBytes, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': makeAttachmentDisposition(`${safeArchiveName(repo.name || 'repository')}.zip`), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }

    if (parts[2] === 'raw' && parts[3]) {
      const file = (repo.files || []).find(f => f.id === parts[3]);
      if (!file) return new Response('File not found', { status: 404 });
      const bytes = await getFileBytes(env, file);
      const filename = file.name || 'file';
      const mimeType = file.mimeType || getMimeType(filename);
      const force = url.searchParams.get('download') === '1' || shouldForceDownloadRaw(file, mimeType, filename);
      return new Response(bytes, { headers: { 'Content-Type': mimeType, 'Content-Disposition': force ? makeAttachmentDisposition(filename) : `inline; filename="${filename.replace(/"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`, 'X-Content-Type-Options': 'nosniff' } });
    }

    const fileLinks = (repo.files || []).map(f => `<div class="file-row"><div class="file-main"><span>${getFileIconFromName(f.name, f.language)}</span><b>${escapeHtml(f.name)}</b><small>${escapeHtml(f.language || '')}</small></div><div class="file-actions"><a href="/s/${shareId}/raw/${f.id}${share.password ? '?p=' + encodeURIComponent(url.searchParams.get('p') || '') : ''}" target="_blank">👁️ Raw</a><a href="/s/${shareId}/raw/${f.id}?download=1${share.password ? '&p=' + encodeURIComponent(url.searchParams.get('p') || '') : ''}">📥 Download</a></div></div>`).join('') || '<div class="empty">📭 Belum ada file.</div>';
    return new Response(`<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(repo.name)} Share</title><style>${sharedV4Css()}</style></head><body><header><div class="wrap nav"><a class="brand" href="/">🚀 CodeHub <span>V5.3 Final</span></a></div></header><main class="wrap"><section class="repo-hero"><div><div class="pill">🔗 Shared Repository</div><h1>📦 ${escapeHtml(repo.name)}</h1><p>${escapeHtml(repo.description || '')}</p></div></section><section class="panel"><h2>📦 Export</h2><div class="row-actions"><a class="btn" href="/s/${shareId}/download${share.password ? '?p=' + encodeURIComponent(url.searchParams.get('p') || '') : ''}">📦 Download ZIP</a></div></section><section class="file-list">${fileLinks}</section></main></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }


  async function handleReleaseRoute(request, env, path) {
    try {
      const parts = path.split('/').filter(Boolean);
      const repoId = parts[1], releaseId = parts[2], fileId = parts[3] || '';
      const repo = await loadRepo(env, repoId);
      if (!repo) return new Response('Repository not found', { status: 404 });
      const auth = await authenticate(request, env);
      if (!canAccessRepo(repo, auth.user)) return new Response('Private release. Login required.', { status: 403 });
      const release = (repo.releases || []).find(r => r.id === releaseId || r.version === releaseId);
      if (!release) return new Response('Release not found', { status: 404 });
      release.downloads = Number(release.downloads || 0) + 1;
      repo.stats = repo.stats || {};
      repo.stats.releaseDownloads = Number(repo.stats.releaseDownloads || 0) + 1;
      await r2Put(env, `repo:${repoId}`, JSON.stringify(repo));
      const allowedIds = new Set(release.fileIds || []);
      if (fileId) {
        if (allowedIds.size && !allowedIds.has(fileId)) return new Response('File is not part of this release', { status: 403 });
        const file = (repo.files || []).find(f => f.id === fileId);
        if (!file) return new Response('File not found', { status: 404 });
        const bytes = await getFileBytes(env, file);
        return new Response(bytes, { headers: { 'Content-Type': file.mimeType || getMimeType(file.name || 'file'), 'Content-Disposition': makeAttachmentDisposition(file.name || 'file'), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      }
      const files = allowedIds.size ? (repo.files || []).filter(f => allowedIds.has(f.id)) : (repo.files || []);
      const exportRepo = { ...repo, name: `${repo.name || 'repository'}-${release.version || 'release'}`, files };
      const zipBytes = await createZipArchive(env, exportRepo);
      return new Response(zipBytes, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': makeAttachmentDisposition(`${safeArchiveName(exportRepo.name)}.zip`), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch (error) {
      console.error('Release route error:', error);
      return new Response('Release download error: ' + error.message, { status: 500 });
    }
  }

  async function listTrashRepos(env) {
    const trashObjects = await r2List(env, 'trash:repo:');
    const repos = [];
    for (const obj of trashObjects) {
      const data = await r2Get(env, obj.key);
      if (!data) continue;
      try {
        const wrapper = JSON.parse(data);
        repos.push({ trashKey: obj.key, repoId: obj.key.replace('trash:repo:', ''), ...wrapper });
      } catch (_) {}
    }
    return repos.sort((a,b)=>String(b.deletedAt||'').localeCompare(String(a.deletedAt||'')));
  }

  
  // File Upload Handler
async function handleFileUpload(request, env) {
    try {
      const authResult = await authenticate(request, env);
      if (!authResult.authenticated) return jsonResponse({ error: 'Unauthorized' }, 401);
      const formData = await request.formData();
      const file = formData.get('file');
      const repoId = formData.get('repoId');
      if (!file || !repoId) return jsonResponse({ error: 'File and repository ID are required' }, 400);
      const repo = await loadRepo(env, repoId);
      if (!repo) return jsonResponse({ error: 'Repository not found' }, 404);
      if (!canAccessRepo(repo, authResult.user)) return jsonResponse({ error: 'Forbidden' }, 403);
      const fileName = sanitizePath(file.name || 'uploaded-file');
      const mimeType = file.type || getMimeType(fileName);
      const fileId = generateId();
      const isText = isTextMime(mimeType, fileName);
      const fileData = { id: fileId, name: fileName, language: getLanguageFromName(fileName), mimeType, isText, created: new Date().toISOString(), updated: new Date().toISOString(), size: file.size };
      if (isText) {
        fileData.content = await file.text();
        fileData.securityWarnings = scanTextSecrets(fileName, fileData.content);
      } else {
        const fileBytes = new Uint8Array(await file.arrayBuffer());
        const storageKey = storageKeyForFile(fileId);
        await r2Put(env, storageKey, fileBytes, {
          httpMetadata: { contentType: mimeType },
          customMetadata: { filename: fileName, repoId, isText: 'false' }
        });
        fileData.encoding = 'r2';
        fileData.storageKey = storageKey;
        attachBinaryBackup(fileData, fileBytes);
      }
      repo.files = repo.files || [];
      const existingFileIndex = repo.files.findIndex(f => f.name === fileName);
      if (existingFileIndex !== -1) {
        await deleteStoredFileObject(env, repo.files[existingFileIndex]);
        repo.files[existingFileIndex] = fileData;
      } else repo.files.push(fileData);
      repo.updated = new Date().toISOString();
      await r2Put(env, `repo:${repoId}`, JSON.stringify(repo));
      return jsonResponse({ success: true, file: fileData, message: existingFileIndex !== -1 ? 'File updated successfully' : 'File uploaded successfully' });
    } catch (error) {
      console.error('File upload error:', error);
      return jsonResponse({ error: 'File upload failed: ' + error.message }, 500);
    }
  }

  
  // Import File from URL Handler - DIPERBAIKI untuk support lebih banyak URL
  async function handleImportFromURL(request, env, user) {
    try {
        const data = await request.json();
        const { url, fileName, repoId } = data;
        
        if (!url || !repoId) {
            return jsonResponse({ error: 'URL and repository ID are required' }, 400);
        }
  
        // Validate URL
        let fileUrl;
        try {
            fileUrl = new URL(url);
        } catch (e) {
            return jsonResponse({ error: 'Invalid URL' }, 400);
        }
  
        // Get repository
        const repoData = await r2Get(env, `repo:${repoId}`);
        if (!repoData) {
            return jsonResponse({ error: 'Repository not found' }, 404);
        }
  
        const repo = JSON.parse(repoData);
        
        // Authorization check
        if (user.role !== 'admin' && repo.owner !== user.id) {
            return jsonResponse({ error: 'Forbidden' }, 403);
        }
  
        // Enhanced URL handling dengan headers yang lebih baik
        const fetchOptions = {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; CodeHub-Bot/1.0)',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
            },
            redirect: 'follow'
        };
  
        // Fetch content from URL dengan error handling yang lebih baik
        let response;
        try {
            response = await fetch(url, fetchOptions);
        } catch (fetchError) {
            console.error('Fetch error:', fetchError);
            return jsonResponse({ error: `Network error: ${fetchError.message}` }, 400);
        }
  
        if (!response.ok) {
            // Coba tanpa headers jika gagal
            try {
                response = await fetch(url);
            } catch (secondError) {
                return jsonResponse({ 
                    error: `Failed to fetch URL: ${response.status} ${response.statusText}. Also failed retry: ${secondError.message}` 
                }, 400);
            }
            
            if (!response.ok) {
                return jsonResponse({ 
                    error: `Failed to fetch URL: ${response.status} ${response.statusText}` 
                }, 400);
            }
        }
  
        const responseBytes = new Uint8Array(await response.arrayBuffer());
        const responseContentType = response.headers.get('content-type') || '';
        
        // Determine file name dengan logic yang lebih baik
        let finalFileName = fileName;
        if (!finalFileName) {
            // Extract filename from URL path
            const urlPath = fileUrl.pathname;
            finalFileName = urlPath.split('/').pop() || 'imported-file';
            
            // Remove query parameters dari filename
            finalFileName = finalFileName.split('?')[0];
            finalFileName = finalFileName.split('#')[0];
            
            // Jika masih tidak ada extension, coba dari content type
            if (!finalFileName.includes('.')) {
                const contentType = response.headers.get('content-type');
                if (contentType) {
                    const extensionMap = {
                        'text/javascript': 'js',
                        'application/javascript': 'js',
                        'application/x-javascript': 'js',
                        'text/x-python': 'py',
                        'application/x-python': 'py',
                        'text/html': 'html',
                        'text/css': 'css',
                        'text/plain': 'txt',
                        'application/json': 'json',
                        'application/xml': 'xml',
                        'text/xml': 'xml'
                    };
                    
                    const ext = extensionMap[contentType] || 'txt';
                    finalFileName = `${finalFileName}.${ext}`;
                } else {
                    // Default to .txt jika tidak bisa menentukan
                    finalFileName = `${finalFileName}.txt`;
                }
            }
        }
  
        // Determine language based on file extension dengan mapping yang lebih lengkap
        finalFileName = sanitizePath(finalFileName || 'imported-file.txt');
        const fileExtension = finalFileName.split('.').pop()?.toLowerCase() || '';
        const languageMap = {
            'js': 'javascript', 'jsx': 'javascript', 'ts': 'javascript', 'tsx': 'javascript', 'mjs': 'javascript',
            'py': 'python', 'pyw': 'python', 'pyc': 'python',
            'html': 'html', 'htm': 'html', 'xhtml': 'html',
            'css': 'css', 'scss': 'css', 'sass': 'css', 'less': 'css',
            'java': 'java', 'class': 'java', 'jar': 'java',
            'cpp': 'cpp', 'c': 'cpp', 'cc': 'cpp', 'cxx': 'cpp', 'h': 'cpp', 'hpp': 'cpp',
            'php': 'php', 'php3': 'php', 'php4': 'php', 'php5': 'php', 'phtml': 'php',
            'rb': 'ruby', 'erb': 'ruby',
            'go': 'go',
            'rs': 'rust',
            'swift': 'swift',
            'kt': 'kotlin', 'kts': 'kotlin',
            'txt': 'text', 'md': 'text', 'markdown': 'text', 'rst': 'text',
            'json': 'javascript', 'json5': 'javascript',
            'xml': 'text', 'xsl': 'text', 'xslt': 'text',
            'csv': 'text', 'tsv': 'text',
            'sql': 'sql',
            'sh': 'bash', 'bash': 'bash', 'zsh': 'bash',
            'yaml': 'yaml', 'yml': 'yaml',
            'toml': 'toml',
            'ini': 'ini', 'cfg': 'ini', 'conf': 'ini'
        };
  
        const language = languageMap[fileExtension] || 'text';
  
        // Create file object. Binary imports are stored as real R2 objects, not empty text.
        const fileId = generateId();
        const mimeType = responseContentType.split(';')[0] || getMimeType(finalFileName);
        const isText = isTextMime(mimeType, finalFileName);
        const fileData = {
            id: fileId,
            name: finalFileName,
            language: isText ? language : getLanguageFromName(finalFileName),
            mimeType,
            isText,
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            size: responseBytes.length,
            importedFrom: url
        };
        if (isText) {
            fileData.content = new TextDecoder().decode(responseBytes);
            fileData.securityWarnings = scanTextSecrets(finalFileName, fileData.content);
        } else {
            const storageKey = storageKeyForFile(fileId);
            await r2Put(env, storageKey, responseBytes, {
              httpMetadata: { contentType: mimeType },
              customMetadata: { filename: finalFileName, repoId, isText: 'false', importedFrom: url }
            });
            fileData.encoding = 'r2';
            fileData.storageKey = storageKey;
            attachBinaryBackup(fileData, responseBytes);
        }
  
        if (!repo.files) {
            repo.files = [];
        }
  
        // Check if file with same name already exists
        const existingFileIndex = repo.files.findIndex(f => f.name === finalFileName);
        if (existingFileIndex !== -1) {
            // Replace existing file
            await deleteStoredFileObject(env, repo.files[existingFileIndex]);
            repo.files[existingFileIndex] = fileData;
        } else {
            // Add new file
            repo.files.push(fileData);
        }
  
        await r2Put(env, `repo:${repoId}`, JSON.stringify(repo));
  
        return jsonResponse({
            success: true,
            file: fileData,
            message: existingFileIndex !== -1 ? 'File updated successfully from URL' : 'File imported successfully from URL'
        });
  
    } catch (error) {
        console.error('Import from URL error:', error);
        return jsonResponse({ error: 'Import from URL failed: ' + error.message }, 500);
    }
  }
  
  // Login handler
async function handleLogin(request, env) {
    if (request.method === 'GET') {
      return serveLoginPage(env);
    }

    if (request.method === 'POST') {
      try {
        const credentials = await request.json();
        const { username, password } = credentials;
        const adminUser = getAdminUser(env);
        const adminPass = getAdminPass(env);

        if (String(username || '') === adminUser && String(password || '') === adminPass) {
          const sessionId = generateId();
          const userData = {
            id: 'admin',
            username: adminUser,
            role: 'admin'
          };

          const sessionData = {
            user: userData,
            expires: Date.now() + (24 * 60 * 60 * 1000)
          };

          await r2Put(env, `session:${sessionId}`, JSON.stringify(sessionData));

          return new Response(JSON.stringify({ success: true, user: userData }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
            }
          });
        }

        return jsonResponse({ error: 'Username atau password salah' }, 401);
      } catch (error) {
        console.error('Login error:', error);
        return jsonResponse({ error: 'Login failed' }, 500);
      }
    }

    return new Response('Method not allowed', { status: 405 });
  }

  
  // Logout handler
  async function handleLogout(request, env) {
    try {
      const cookieHeader = request.headers.get('Cookie');
      if (cookieHeader && cookieHeader.includes('session=')) {
        const sessionMatch = cookieHeader.match(/session=([^;]+)/);
        if (sessionMatch) {
          await r2Delete(env, `session:${sessionMatch[1]}`);
        }
      }
      
      return new Response(JSON.stringify({ success: true }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Set-Cookie': 'session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
        }
      });
    } catch (error) {
      return jsonResponse({ error: 'Logout failed' }, 500);
    }
  }
  
  // Public homepage
async function servePublicHomepage(env) {
    try {
      const repoObjects = await r2List(env, 'repo:');
      const repoList = [];
      for (const obj of repoObjects) {
        try {
          const repoData = await r2Get(env, obj.key);
          if (!repoData) continue;
          const repo = JSON.parse(repoData);
          if (normalizeVisibility(repo) !== 'public') continue;
          const repoId = obj.key.replace('repo:', '');
          repoList.push({ id: repoId, name: repo.name, description: repo.description, created: repo.created, files: repo.files ? repo.files.length : 0, visibility: normalizeVisibility(repo) });
        } catch (e) { console.error('Error parsing repo data:', e); }
      }
      repoList.sort((a,b)=>String(b.created||'').localeCompare(String(a.created||'')));
      const html = `<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>🚀 CodeHub V5.4 Final Pro</title><style>${sharedV4Css()}</style></head><body><header><div class="wrap nav"><a class="brand" href="/">🚀 CodeHub <span>V5.4 Final Pro</span></a><div class="nav-actions"><a class="btn ghost" href="/manifest.webmanifest">📱 PWA</a><a class="btn" href="/login">🔐 Login</a></div></div></header><main class="wrap"><section class="hero"><div><div class="pill">✨ Public Repository R2</div><h1>📦 Simpan kode & file dengan tampilan estetik.</h1><p>Download ZIP, raw link, Git clone, preview file, dan dashboard private/public repo.</p></div><div class="hero-stat"><b>${repoList.length}</b><span>Public Repo</span><b>${repoList.reduce((t,r)=>t+(r.files||0),0)}</b><span>Total File</span></div></section><section class="toolbar"><h2>🌍 Public Repositories</h2><input id="q" class="search" placeholder="🔎 Cari repo publik..." oninput="filterRepos()"></section><section id="repoGrid" class="grid">${repoList.length ? repoList.map(repo => `<a class="repo-card" data-search="${escapeHtml((repo.name+' '+(repo.description||'')).toLowerCase())}" href="${escapeHtml(publicRepoPathForRepo(repo.id, repo))}"><div class="card-icon">📦</div><h3>${escapeHtml(repo.name)}</h3><p>${escapeHtml(repo.description || 'No description')}</p><div class="meta"><span>📄 ${repo.files || 0} file</span><span>🌍 public</span></div></a>`).join('') : '<div class="empty">📭 Belum ada repo publik.</div>'}</section></main><script>function filterRepos(){var q=document.getElementById('q').value.toLowerCase();document.querySelectorAll('.repo-card').forEach(function(c){c.style.display=c.dataset.search.indexOf(q)>-1?'block':'none'})}</script></body></html>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    } catch (error) {
      console.error('Error loading repositories:', error);
      return new Response('Error loading repositories', { status: 500 });
    }
  }

  
  // Public repository view dengan README di bagian bawah
async function handlePublicRepo(request, env, path) {
    try {
      const repoId = path.split('/')[2];
      const repo = await loadRepo(env, repoId);
      if (!repo) return new Response('Repository not found', { status: 404 });
      const auth = await authenticate(request, env);
      if (!canAccessRepo(repo, auth.user)) {
        return new Response('🔒 Repository private. Silakan login dulu.', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
      await incrementRepoStat(env, repoId, repo, 'views', 1);
      const baseUrl = new URL(request.url).origin;
      const gitCloneUrl = `${baseUrl}${gitClonePathForRepo(repoId, repo)}`;
      const publicRepoUrl = `${baseUrl}${publicRepoPathForRepo(repoId, repo)}`;
      const readme = repo.readme || { content: '# ' + repo.name + '\n\n' + (repo.description || 'No description provided'), lastUpdated: repo.created };
      const visibility = normalizeVisibility(repo);
      const files = Array.isArray(repo.files) ? repo.files : [];
      const html = `<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(repo.name)} - CodeHub V5.4</title><style>${sharedV4Css()}</style></head><body><header><div class="wrap nav"><a class="brand" href="/">🚀 CodeHub <span>V5.4 Final Pro</span></a><div class="nav-actions"><a class="btn ghost" href="/">← Home</a><a class="btn" href="/login">🔐 Login</a></div></div></header><main class="wrap"><section class="repo-hero"><div><div class="pill">${visibility === 'private' ? '🔒 Private' : '🌍 Public'} Repository</div><h1>📦 ${escapeHtml(repo.name)}</h1><p>${escapeHtml(repo.description || 'No description provided')}</p><div class="meta big"><span>📄 ${files.length} file</span><span>🕒 ${new Date(repo.created).toLocaleDateString()}</span></div></div></section><section class="panel"><h2>🔗 Clone & Download</h2><div class="linkbox"><input id="pub" value="${publicRepoUrl}" readonly><button onclick="copyText('pub')">📋 Copy URL</button></div><div class="linkbox"><input id="git" value="${gitCloneUrl}" readonly><button onclick="copyText('git')">📋 Copy Git</button></div><div class="row-actions"><button class="btn" onclick="downloadZip()">📦 Download ZIP</button><a class="btn ghost" href="/download/${repoId}?format=txt">📝 Text Archive</a></div></section><section class="toolbar"><h2>📁 Files</h2><input id="fileSearch" class="search" oninput="filterFiles()" placeholder="🔎 Cari file..."></section><section class="file-list">${files.length ? files.map(file => `<div class="file-row" data-search="${escapeHtml((file.name+' '+(file.language||'')).toLowerCase())}"><div class="file-main"><span>${getFileIconFromName(file.name, file.language)}</span><b>${escapeHtml(file.name)}</b><small>${escapeHtml(file.language || getLanguageFromName(file.name))}</small></div><div class="file-actions"><a href="${baseUrl}/raw/${file.id}" target="_blank">👁️ Raw</a><button onclick="downloadFile('${file.id}','${escapeHtml(file.name)}')">📥 Download</button><button onclick="copyUrl('${baseUrl}/raw/${file.id}')">📋 Copy Raw</button></div></div>`).join('') : '<div class="empty">📭 Belum ada file.</div>'}</section><section class="panel readme"><h2>📘 README.md</h2><article>${renderMarkdown(readme.content)}</article></section></main><script>function copyText(id){navigator.clipboard.writeText(document.getElementById(id).value).then(function(){alert('✅ Disalin')})}function copyUrl(u){navigator.clipboard.writeText(u).then(function(){alert('✅ Link disalin')})}function downloadFile(id,name){var a=document.createElement('a');a.href='/raw/'+id+'?download=1';a.download=name;document.body.appendChild(a);a.click();a.remove()}function downloadZip(){var a=document.createElement('a');a.href='/download/${repoId}';a.download='${escapeHtml(safeArchiveName(repo.name || 'repository'))}.zip';document.body.appendChild(a);a.click();a.remove()}function filterFiles(){var q=document.getElementById('fileSearch').value.toLowerCase();document.querySelectorAll('.file-row').forEach(function(r){r.style.display=r.dataset.search.indexOf(q)>-1?'flex':'none'})}</script></body></html>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    } catch (error) {
      console.error('Error loading repository:', error);
      return new Response('Error loading repository', { status: 500 });
    }
  }

  
  // Raw file handler - DIPERBAIKI untuk selalu return text/plain
async function handleRawFile(request, env, path) {
    try {
      const fileId = path.split('/')[2];
      if (!fileId) return new Response('File ID is required', { status: 400 });
      const found = await findRepoByFile(env, fileId);
      if (!found) return new Response('File not found', { status: 404 });
      const auth = await authenticate(request, env);
      if (!canAccessRepo(found.repo, auth.user)) {
        return new Response('Private file. Login required.', { status: 403 });
      }
      const url = new URL(request.url);
      const file = found.file;
      const filename = file.name || 'file';
      const mimeType = file.mimeType || getMimeType(filename);
      const forceDownload = url.searchParams.get('download') === '1' || shouldForceDownloadRaw(file, mimeType, filename);
      const disposition = forceDownload
        ? makeAttachmentDisposition(filename)
        : `inline; filename="${filename.replace(/"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
      const bytes = await getFileBytes(env, file);
      await incrementFileStat(env, found.repoId, found.repo, fileId, forceDownload ? 'downloads' : 'views', 1);
      return new Response(bytes, {
        headers: {
          'Content-Type': mimeType,
          'Content-Disposition': disposition,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=3600',
          'X-Content-Type-Options': 'nosniff'
        }
      });
    } catch (error) {
      console.error('Error loading file:', error);
      return new Response('Error loading file', { status: 500 });
    }
  }

  
  // Download handler: default ZIP, optional text archive via ?format=txt
async function handleDownloadRepo(request, env, path) {
    try {
      const repoId = path.split('/')[2];
      const repo = await loadRepo(env, repoId);
      if (!repo) return new Response('Repository not found', { status: 404 });
      const auth = await authenticate(request, env);
      if (!canAccessRepo(repo, auth.user)) return new Response('Private repository. Login required.', { status: 403 });
      const url = new URL(request.url);
      const format = (url.searchParams.get('format') || 'zip').toLowerCase();
      const pathPrefix = sanitizePath(url.searchParams.get('path') || '', '');
      let exportRepo = repo;
      if (pathPrefix) {
        const prefix = pathPrefix.endsWith('/') ? pathPrefix : pathPrefix + '/';
        exportRepo = { ...repo, name: `${repo.name || 'repository'}-${pathPrefix.replace(/\/$/, '')}`, files: (repo.files || []).filter(f => String(f.name || '').startsWith(prefix)) };
      }
      const safeName = safeArchiveName(exportRepo.name || 'repository');
      if (format === 'txt' || format === 'text') {
        const archiveContent = createTextArchive(exportRepo);
        return new Response(archiveContent, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': makeAttachmentDisposition(`${safeName}-archive.txt`), 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
      }
      const zipBytes = await createZipArchive(env, exportRepo);
      await incrementRepoStat(env, repoId, repo, 'zipDownloads', 1);
      return new Response(zipBytes, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': makeAttachmentDisposition(`${safeName}.zip`), 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch (error) {
      console.error('Error creating archive:', error);
      return new Response('Error creating archive', { status: 500 });
    }
  }


  function createTextArchive(repo) {
    const folderName = repo.name;
    const timestamp = new Date().toLocaleString();
    
    let archiveContent = '';
    
    archiveContent += '╔══════════════════════════════════════════════════╗\n';
    archiveContent += '║                CODE REPOSITORY ARCHIVE           ║\n';
    archiveContent += '╠══════════════════════════════════════════════════╣\n';
    archiveContent += `║ Repository: ${folderName.padEnd(36)} ║\n`;
    archiveContent += `║ Generated: ${timestamp.padEnd(37)} ║\n`;
    archiveContent += `║ Files: ${String(repo.files ? repo.files.length : 0).padEnd(40)} ║\n`;
    archiveContent += `║ Description: ${(repo.description || 'No description').substring(0, 34).padEnd(35)} ║\n`;
    archiveContent += '╚══════════════════════════════════════════════════╝\n\n';
    
    archiveContent += 'FILE SUMMARY\n';
    archiveContent += '────────────────────────────────────────────────────\n';
    
    if (repo.files && repo.files.length > 0) {
      let totalSize = 0;
      const languageCount = {};
      
      repo.files.forEach(file => {
        totalSize += file.encoding === 'base64' ? (file.size || 0) : (file.content || '').length;
        languageCount[file.language] = (languageCount[file.language] || 0) + 1;
      });
      
      archiveContent += `Total files: ${repo.files.length}\n`;
      archiveContent += `Total size: ${totalSize} characters\n`;
      archiveContent += `Folder structure: ${folderName}/\n\n`;
      
      archiveContent += 'Languages:\n';
      for (const [lang, count] of Object.entries(languageCount)) {
        archiveContent += `  - ${lang}: ${count} files\n`;
      }
      archiveContent += '\n';
    } else {
      archiveContent += 'No files in this repository\n\n';
    }
    
    archiveContent += 'FILE CONTENTS\n';
    archiveContent += '════════════════════════════════════════════════════\n\n';
    
    if (repo.files && repo.files.length > 0) {
      repo.files.forEach((file, index) => {
        const fileNumber = (index + 1).toString().padStart(2, '0');
        const filePath = `${folderName}/${file.name}`;
        const fileSize = file.size || (file.content ? file.content.length : 0);
        const createdDate = file.created ? new Date(file.created).toLocaleDateString() : 'Unknown';
        
        archiveContent += `┌── FILE ${fileNumber}: ${filePath}\n`;
        archiveContent += `│   Size: ${fileSize} characters\n`;
        archiveContent += `│   Language: ${file.language}\n`;
        archiveContent += `│   Created: ${createdDate}\n`;
        archiveContent += `└────────────────────────────────────────────────────\n\n`;
        
        archiveContent += fileContentForTextArchive(file);
        
        if (index < repo.files.length - 1) {
          archiveContent += '\n\n' + '─'.repeat(60) + '\n\n';
        }
      });
    }
    
    archiveContent += '\n\n' + '═'.repeat(60) + '\n';
    archiveContent += `ARCHIVE COMPLETE - ${repo.files ? repo.files.length : 0} files exported\n`;
    archiveContent += `Location: ${folderName}/\n`;
    archiveContent += `Exported: ${timestamp}\n`;
    archiveContent += `Source: CodeHub Repository\n`;
    archiveContent += '═'.repeat(60) + '\n';
    
    return archiveContent;
  }

  // ============================================
  // ZIP ARCHIVE SUPPORT
  // ============================================

  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function textBytes(text) {
    return new TextEncoder().encode(String(text ?? ''));
  }

  function concatBytes(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function pushU16LE(out, value) {
    out.push(value & 0xFF, (value >>> 8) & 0xFF);
  }

  function pushU32LE(out, value) {
    out.push(value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF);
  }

  function pushU32BE(out, value) {
    out.push((value >>> 24) & 0xFF, (value >>> 16) & 0xFF, (value >>> 8) & 0xFF, value & 0xFF);
  }

  function safeArchiveName(name, fallback = 'repository') {
    const cleaned = String(name || fallback)
      .replace(/[\\/]+/g, '-')
      .replace(/[\x00-\x1F<>:"|?*]+/g, '_')
      .replace(/^\.+$/, '')
      .trim();
    return cleaned || fallback;
  }

  function slugifyRepoName(name, fallback = 'repository') {
    const slug = String(name || fallback)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\.git$/i, '')
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-');
    return slug || fallback;
  }

  function gitClonePathForRepo(repoId, repo) {
    const slug = slugifyRepoName((repo && repo.name) || repoId || 'repository');
    return `/${encodeURIComponent(slug)}.git`;
  }

  function publicRepoPathForRepo(repoId, repo) {
    const slug = slugifyRepoName((repo && repo.name) || repoId || 'repository');
    return `/${encodeURIComponent(slug)}`;
  }

  function safeArchivePath(name, index = 0) {
    const fallback = `file-${index + 1}.txt`;
    const parts = String(name || fallback)
      .replace(/\\/g, '/')
      .split('/')
      .map(part => part.replace(/[\x00-\x1F<>:"|?*]+/g, '_').trim())
      .filter(part => part && part !== '.' && part !== '..');
    return parts.join('/') || fallback;
  }

  function uniqueArchivePath(path, used) {
    if (!used.has(path)) {
      used.add(path);
      return path;
    }
    const slashIndex = path.lastIndexOf('/');
    const dir = slashIndex >= 0 ? path.slice(0, slashIndex + 1) : '';
    const name = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let i = 2;
    let candidate;
    do {
      candidate = `${dir}${base}-${i}${ext}`;
      i++;
    } while (used.has(candidate));
    used.add(candidate);
    return candidate;
  }

  function makeAttachmentDisposition(filename) {
    const fallback = safeArchiveName(filename, 'download');
    return `attachment; filename="${fallback.replace(/"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }

  function zipDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { dosTime, dosDate };
  }

  async function createZipArchive(env, repo) {
    const folder = safeArchiveName(repo.name || 'repository');
    const files = Array.isArray(repo.files) ? repo.files : [];
    const used = new Set();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    const zipFiles = files.slice();
    const hasReadme = zipFiles.some(file => /^readme(\.[a-z0-9]+)?$/i.test(String(file.name || '').split('/').pop() || ''));
    if (!hasReadme && repo.readme && typeof repo.readme.content === 'string') {
      zipFiles.push({ name: 'README.md', content: repo.readme.content, created: repo.readme.lastUpdated || repo.created });
    }
    if (zipFiles.length === 0) {
      zipFiles.push({ name: 'README.txt', content: 'This repository has no files yet.\n', created: repo.created });
    }

    for (let index = 0; index < zipFiles.length; index++) {
      const file = zipFiles[index];
      const relativePath = safeArchivePath(file.name, index);
      const zipPath = uniqueArchivePath(`${folder}/${relativePath}`, used);
      const fileNameBytes = textBytes(zipPath);
      const contentBytes = await getFileBytes(env, file);
      const crc = crc32(contentBytes);
      const size = contentBytes.length;
      const { dosTime, dosDate } = zipDateTime(file.created ? new Date(file.created) : new Date());
      const localOffset = offset;

      const localHeader = [];
      pushU32LE(localHeader, 0x04034b50);
      pushU16LE(localHeader, 20);       // version needed
      pushU16LE(localHeader, 0x0800);   // UTF-8 names
      pushU16LE(localHeader, 0);        // no compression/store
      pushU16LE(localHeader, dosTime);
      pushU16LE(localHeader, dosDate);
      pushU32LE(localHeader, crc);
      pushU32LE(localHeader, size);
      pushU32LE(localHeader, size);
      pushU16LE(localHeader, fileNameBytes.length);
      pushU16LE(localHeader, 0);

      const localChunk = concatBytes([new Uint8Array(localHeader), fileNameBytes, contentBytes]);
      localParts.push(localChunk);
      offset += localChunk.length;

      const centralHeader = [];
      pushU32LE(centralHeader, 0x02014b50);
      pushU16LE(centralHeader, 20);      // version made by
      pushU16LE(centralHeader, 20);      // version needed
      pushU16LE(centralHeader, 0x0800);  // UTF-8 names
      pushU16LE(centralHeader, 0);
      pushU16LE(centralHeader, dosTime);
      pushU16LE(centralHeader, dosDate);
      pushU32LE(centralHeader, crc);
      pushU32LE(centralHeader, size);
      pushU32LE(centralHeader, size);
      pushU16LE(centralHeader, fileNameBytes.length);
      pushU16LE(centralHeader, 0);
      pushU16LE(centralHeader, 0);
      pushU16LE(centralHeader, 0);
      pushU16LE(centralHeader, 0);
      pushU32LE(centralHeader, 0);
      pushU32LE(centralHeader, localOffset);
      centralParts.push(concatBytes([new Uint8Array(centralHeader), fileNameBytes]));
    }

    const centralDirectory = concatBytes(centralParts);
    const end = [];
    pushU32LE(end, 0x06054b50);
    pushU16LE(end, 0);
    pushU16LE(end, 0);
    pushU16LE(end, zipFiles.length);
    pushU16LE(end, zipFiles.length);
    pushU32LE(end, centralDirectory.length);
    pushU32LE(end, offset);
    pushU16LE(end, 0);

    return concatBytes([...localParts, centralDirectory, new Uint8Array(end)]);
  }

  // ============================================
  // MINIMAL SMART HTTP GIT CLONE SUPPORT
  // ============================================

  function hexFromBytes(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function bytesFromHex(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  async function sha1(bytes) {
    return new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
  }

  async function gitObject(type, content) {
    const body = content instanceof Uint8Array ? content : textBytes(content);
    const store = concatBytes([textBytes(`${type} ${body.length}\0`), body]);
    const hashBytes = await sha1(store);
    return {
      type,
      content: body,
      store,
      hashBytes,
      hashHex: hexFromBytes(hashBytes)
    };
  }

  async function prepareGitFiles(env, repo) {
    const result = [];
    const files = Array.isArray(repo.files) ? repo.files : [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      result.push({
        name: safeArchivePath(file.name, i),
        content: await getFileBytes(env, file)
      });
    }

    const hasReadme = result.some(file => /^readme(\.[a-z0-9]+)?$/i.test(file.name.split('/').pop() || ''));
    if (!hasReadme && repo.readme && typeof repo.readme.content === 'string') {
      result.push({ name: 'README.md', content: repo.readme.content });
    }

    if (result.length === 0) {
      result.push({ name: 'README.md', content: `# ${repo.name || 'Repository'}\n\nThis repository has no files yet.\n` });
    }
    return result;
  }

  function addGitFile(root, path, content) {
    const parts = path.split('/').filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        node.files.set(part, content);
      } else {
        if (!node.dirs.has(part)) {
          node.dirs.set(part, { dirs: new Map(), files: new Map() });
        }
        node = node.dirs.get(part);
      }
    }
  }

  async function buildGitTree(node, objects) {
    const entries = [];

    for (const [name, content] of node.files.entries()) {
      const blob = await gitObject('blob', content instanceof Uint8Array ? content : textBytes(content));
      objects.push(blob);
      entries.push({ mode: '100644', name, hashBytes: blob.hashBytes, sortName: name });
    }

    for (const [name, child] of node.dirs.entries()) {
      const tree = await buildGitTree(child, objects);
      entries.push({ mode: '40000', name, hashBytes: tree.hashBytes, sortName: `${name}/` });
    }

    entries.sort((a, b) => a.sortName.localeCompare(b.sortName));

    const parts = [];
    for (const entry of entries) {
      parts.push(textBytes(`${entry.mode} ${entry.name}\0`));
      parts.push(entry.hashBytes);
    }

    const treeObj = await gitObject('tree', concatBytes(parts));
    objects.push(treeObj);
    return treeObj;
  }

  async function createGitSnapshot(env, repo) {
    const root = { dirs: new Map(), files: new Map() };
    const used = new Set();
    const gitFiles = await prepareGitFiles(env, repo);

    gitFiles.forEach((file, index) => {
      const normalized = uniqueArchivePath(safeArchivePath(file.name, index), used);
      addGitFile(root, normalized, file.content);
    });

    const objects = [];
    const tree = await buildGitTree(root, objects);
    const createdMs = Date.parse(repo.created || '') || 946684800000;
    const timestamp = Math.floor(createdMs / 1000);
    const author = 'CodeHub <codehub@example.local>';
    const message = `Export ${repo.name || 'repository'} from CodeHub`;
    const commitBody = [
      `tree ${tree.hashHex}`,
      `author ${author} ${timestamp} +0000`,
      `committer ${author} ${timestamp} +0000`,
      '',
      message,
      ''
    ].join('\n');
    const commit = await gitObject('commit', textBytes(commitBody));
    objects.push(commit);

    // Put commit first. Other objects can follow in any order for clone.
    const ordered = [commit, ...objects.filter(obj => obj !== commit)];
    return { commit, objects: ordered };
  }

  function pktLine(data) {
    const body = data instanceof Uint8Array ? data : textBytes(data);
    const len = (body.length + 4).toString(16).padStart(4, '0');
    return concatBytes([textBytes(len), body]);
  }

  function pktFlush() {
    return textBytes('0000');
  }

  function gitPackObjectHeader(typeCode, size) {
    const out = [];
    let first = (typeCode << 4) | (size & 0x0F);
    size >>>= 4;
    if (size > 0) first |= 0x80;
    out.push(first);
    while (size > 0) {
      let byte = size & 0x7F;
      size >>>= 7;
      if (size > 0) byte |= 0x80;
      out.push(byte);
    }
    return new Uint8Array(out);
  }

  function adler32(bytes) {
    let a = 1;
    let b = 0;
    const MOD = 65521;
    for (let i = 0; i < bytes.length; i++) {
      a = (a + bytes[i]) % MOD;
      b = (b + a) % MOD;
    }
    return (((b << 16) | a) >>> 0);
  }

  function zlibStoreBytes(bytes) {
    // Git pack membutuhkan object zlib-compressed. Untuk file foto/ZIP/APK,
    // compression runtime bisa berat dan menyebabkan Worker 503.
    // Di sini kita buat zlib valid dengan DEFLATE stored blocks (tanpa kompresi):
    // CPU ringan, binary tetap utuh, dan git clone tidak putus saat ada file besar.
    const chunks = [new Uint8Array([0x78, 0x01])];
    let offset = 0;
    if (bytes.length === 0) {
      chunks.push(new Uint8Array([0x01, 0x00, 0x00, 0xff, 0xff]));
    } else {
      while (offset < bytes.length) {
        const len = Math.min(65535, bytes.length - offset);
        const finalBlock = offset + len >= bytes.length;
        const header = [];
        header.push(finalBlock ? 0x01 : 0x00);
        pushU16LE(header, len);
        pushU16LE(header, (~len) & 0xffff);
        chunks.push(new Uint8Array(header));
        chunks.push(bytes.slice(offset, offset + len));
        offset += len;
      }
    }
    const checksum = [];
    pushU32BE(checksum, adler32(bytes));
    chunks.push(new Uint8Array(checksum));
    return concatBytes(chunks);
  }

  async function deflateBytes(bytes) {
    return zlibStoreBytes(bytes);
  }

  async function createGitPack(objects) {
    const typeMap = { commit: 1, tree: 2, blob: 3, tag: 4 };
    const chunks = [textBytes('PACK')];
    const header = [];
    pushU32BE(header, 2);
    pushU32BE(header, objects.length);
    chunks.push(new Uint8Array(header));

    for (const obj of objects) {
      chunks.push(gitPackObjectHeader(typeMap[obj.type], obj.content.length));
      chunks.push(await deflateBytes(obj.content));
    }

    const packWithoutHash = concatBytes(chunks);
    const trailer = await sha1(packWithoutHash);
    return concatBytes([packWithoutHash, trailer]);
  }

  function parseGitRepoId(path) {
    const parts = path.split('/').filter(Boolean);
    if (parts[0] === 'git') return parts[1]?.replace(/\.git$/i, '');
    if (parts[0] === 'repo') return parts[1]?.replace(/\.git$/i, '');
    if (parts[0] && parts[0].endsWith('.git')) return decodeURIComponent(parts[0].replace(/\.git$/i, ''));
    return null;
  }

  function createGitAdvertisement(commitHash) {
    const caps = 'multi_ack multi_ack_detailed thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag symref=HEAD:refs/heads/main agent=codehub-worker';
    return concatBytes([
      pktLine('# service=git-upload-pack\n'),
      pktFlush(),
      pktLine(`${commitHash} HEAD\0${caps}\n`),
      pktLine(`${commitHash} refs/heads/main\n`),
      pktFlush()
    ]);
  }

  function createSideBandPack(packBytes) {
    const chunks = [];
    const maxPayload = 60000;
    for (let offset = 0; offset < packBytes.length; offset += maxPayload) {
      const slice = packBytes.slice(offset, offset + maxPayload);
      const payload = new Uint8Array(slice.length + 1);
      payload[0] = 1;
      payload.set(slice, 1);
      chunks.push(pktLine(payload));
    }
    chunks.push(pktFlush());
    return concatBytes(chunks);
  }

  // Git protocol handler: supports public git clone over smart HTTP.
async function handleGitProtocol(request, env, path) {
    try {
      let repoId = parseGitRepoId(path);
      if (!repoId) return new Response('Repository not found', { status: 404 });
      let repo = await loadRepo(env, repoId);
      if (!repo) {
        const found = await findRepoBySlug(env, repoId);
        if (found) {
          repoId = found.repoId;
          repo = found.repo;
        }
      }
      if (!repo) return new Response('Repository not found', { status: 404 });
      if (!isRepoPublic(repo)) return new Response('Private repository cannot be cloned publicly. Login and download ZIP from dashboard.', { status: 403 });
      const url = new URL(request.url);
      if (request.method === 'GET' && path.endsWith('/info/refs') && url.searchParams.get('service') === 'git-upload-pack') {
        const snapshot = await createGitSnapshot(env, repo);
        return new Response(createGitAdvertisement(snapshot.commit.hashHex), { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' } });
      }
      if (request.method === 'POST' && path.endsWith('/git-upload-pack')) {
        const bodyText = await request.text();
        const useSideBand = bodyText.includes('side-band');
        const snapshot = await createGitSnapshot(env, repo);
        const packBytes = await createGitPack(snapshot.objects);
        const responseBody = useSideBand ? concatBytes([pktLine('NAK\n'), createSideBandPack(packBytes)]) : concatBytes([pktLine('NAK\n'), packBytes]);
        await incrementRepoStat(env, repoId, repo, 'gitClones', 1);
        return new Response(responseBody, { headers: { 'Content-Type': 'application/x-git-upload-pack-result', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' } });
      }
      return new Response('Unsupported Git request. Use: git clone ' + new URL(gitClonePathForRepo(repoId, repo), request.url).href, { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    } catch (error) {
      console.error('Git protocol error:', error);
      return new Response('Git protocol error: ' + error.message, { status: 500 });
    }
  }


  // API handler dengan semua fitur termasuk README dan edit deskripsi
async function handleAPI(request, env, path, user) {
    const method = request.method;
    try {
      const url = new URL(request.url);

      if (path === '/api/system' && method === 'GET') {
        return jsonResponse({
          version: 'CodeHub V5.4 Final Pro',
          envLogin: !!(env.ADMIN_USER || env.ADMIN_PASS),
          pwa: true,
          features: ['private_repo','zip','binary_safe','github_style_git','github_style_public_url','release_manager','stats','share_password_expired','trash_restore','version_history','folder_tree','content_search','security_scanner','theme_switcher']
        });
      }

      if (path === '/api/search' && method === 'GET') {
        const q = (url.searchParams.get('q') || '').toLowerCase().trim();
        const repoIdFilter = url.searchParams.get('repoId') || '';
        const includeContent = url.searchParams.get('content') !== '0';
        const repoObjects = await r2List(env, 'repo:');
        const results = [];
        for (const obj of repoObjects) {
          const repoId = obj.key.replace('repo:', '');
          if (repoIdFilter && repoId !== repoIdFilter) continue;
          const repo = await loadRepo(env, repoId);
          if (!repo || !canAccessRepo(repo, user)) continue;
          const repoHaystack = `${repo.name || ''} ${repo.description || ''} ${repo.visibility || ''}`.toLowerCase();
          const matchingFiles = [];
          for (const f of repo.files || []) {
            let match = `${f.name || ''} ${f.language || ''} ${f.mimeType || ''}`.toLowerCase().includes(q);
            let preview = '';
            if (!match && includeContent && q && f.isText !== false) {
              let text = '';
              if (typeof f.content === 'string') text = f.content;
              else {
                try { text = new TextDecoder().decode(await getFileBytes(env, f)); } catch (_) {}
              }
              const idx = text.toLowerCase().indexOf(q);
              if (idx >= 0) {
                match = true;
                preview = text.slice(Math.max(0, idx - 60), idx + q.length + 120);
              }
            }
            if (!q || match) matchingFiles.push({ id: f.id, name: f.name, language: f.language, mimeType: f.mimeType, size: f.size, preview, stats: f.stats || {}, securityWarnings: f.securityWarnings || [] });
            if (matchingFiles.length >= 50) break;
          }
          if (!q || repoHaystack.includes(q) || matchingFiles.length) results.push({ repo: repoToClient(request, repoId, repo), files: matchingFiles });
          if (results.length >= 50) break;
        }
        return jsonResponse(results);
      }

      if (path === '/api/trash' && method === 'GET') {
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);
        const trashRepos = await listTrashRepos(env);
        return jsonResponse({ repos: trashRepos.map(t => ({ repoId: t.repoId, name: t.repo?.name || 'repository', description: t.repo?.description || '', deletedAt: t.deletedAt })) });
      }

      if (path.match(/^\/api\/trash\/repos\/[^\/]+\/restore$/) && method === 'POST') {
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);
        const repoId = path.split('/')[4];
        const data = await r2Get(env, `trash:repo:${repoId}`);
        if (!data) return jsonResponse({ error: 'Trash repo not found' }, 404);
        const wrapper = JSON.parse(data);
        await r2Put(env, `repo:${repoId}`, JSON.stringify(ensureRepoFinalFields(wrapper.repo)));
        await r2Delete(env, `trash:repo:${repoId}`);
        return jsonResponse({ success: true, repo: repoToClient(request, repoId, wrapper.repo) });
      }

      if (path.match(/^\/api\/trash\/repos\/[^\/]+$/) && method === 'DELETE') {
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);
        const repoId = path.split('/')[4];
        const data = await r2Get(env, `trash:repo:${repoId}`);
        if (!data) return jsonResponse({ error: 'Trash repo not found' }, 404);
        const wrapper = JSON.parse(data);
        if (wrapper.repo && Array.isArray(wrapper.repo.files)) for (const file of wrapper.repo.files) await deleteStoredFileObject(env, file);
        await r2Delete(env, `trash:repo:${repoId}`);
        return jsonResponse({ success: true });
      }

      if (path === '/api/repos' && method === 'GET') {
        const repoObjects = await r2List(env, 'repo:');
        const repoList = [];
        for (const obj of repoObjects) {
          const repoId = obj.key.replace('repo:', '');
          const repo = await loadRepo(env, repoId);
          if (!repo || repo.deleted) continue;
          if (!canAccessRepo(repo, user)) continue;
          if (!user && normalizeVisibility(repo) !== 'public') continue;
          repoList.push(repoToClient(request, repoId, repo));
        }
        repoList.sort((a,b)=>String(b.created||'').localeCompare(String(a.created||'')));
        return jsonResponse(repoList);
      }

      if (path === '/api/repos' && method === 'POST') {
        const data = await request.json();
        const repoId = generateId();
        const name = sanitizePath(data.name || 'new-repository').replace(/\//g, '-');
        const repoData = ensureRepoFinalFields({
          name,
          description: data.description || '',
          visibility: data.visibility === 'private' ? 'private' : 'public',
          created: nowIso(),
          updated: nowIso(),
          owner: user.id,
          files: [], releases: [], shares: [], trashFiles: [], stats: {}
        });
        await r2Put(env, `repo:${repoId}`, JSON.stringify(repoData));
        return jsonResponse(repoToClient(request, repoId, repoData));
      }

      if (path.match(/^\/api\/repos\/[^\/]+$/) && method === 'GET') {
        const repoId = path.split('/')[3];
        const repo = await loadRepo(env, repoId);
        if (!repo || repo.deleted) return jsonResponse({ error: 'Repository not found' }, 404);
        if (!canAccessRepo(repo, user)) return jsonResponse({ error: 'Private repository' }, 403);
        return jsonResponse(repoToClient(request, repoId, repo));
      }

      if (path.match(/^\/api\/repos\/[^\/]+$/) && method === 'PUT') {
        const repoId = path.split('/')[3];
        const data = await request.json();
        const repo = await loadRepo(env, repoId);
        if (!repo) return jsonResponse({ error: 'Repository not found' }, 404);
        if (!canAccessRepo(repo, user)) return jsonResponse({ error: 'Forbidden' }, 403);
        if (data.name !== undefined) repo.name = sanitizePath(data.name || repo.name).replace(/\//g, '-');
        if (data.description !== undefined) repo.description = data.description;
        if (data.visibility !== undefined) repo.visibility = data.visibility === 'private' ? 'private' : 'public';
        await saveRepo(env, repoId, repo);
        return jsonResponse(repoToClient(request, repoId, repo));
      }

      if (path.match(/^\/api\/repos\/[^\/]+\/stats$/) && method === 'GET') {
        const repoId = path.split('/')[3];
        const repo = await loadRepo(env, repoId);
        if (!repo) return jsonResponse({ error: 'Repository not found' }, 404);
        if (!canAccessRepo(repo, user)) return jsonResponse({ error: 'Private repository' }, 403);
        ensureRepoFinalFields(repo);
        const topFiles = [...(repo.files || [])].sort((a,b)=>Number((b.stats||{}).downloads||0)-Number((a.stats||{}).downloads||0)).slice(0,10).map(f=>({id:f.id,name:f.name,downloads:Number((f.stats||{}).downloads||0),views:Number((f.stats||{}).views||0)}));
        return jsonResponse({ stats: repo.stats, topFiles, releases: repo.releases || [], shares: repo.shares || [] });
      }

      if (path.match(/^\/api\/repos\/[^\/]+\/files$/) && method === 'POST') {
        const repoId = path.split('/')[3];
        const data = await request.json();
        const repo = await loadRepo(env, repoId);
        if (!repo) return jsonResponse({ error: 'Repository not found' }, 404);
        if (!canAccessRepo(repo, user)) return jsonResponse({ error: 'Forbidden' }, 403);
        const fileName = sanitizePath(data.name || data.path || 'file.txt');
        const fileId = generateId();
        const content = String(data.content ?? '');
        const fileData = { id: fileId, name: fileName, content, language: data.language || getLanguageFromName(fileName), mimeType: getMimeType(fileName), isText: true, created: nowIso(), updated: nowIso(), size: content.length, versions: [], securityWarnings: scanTextSecrets(fileName, content), stats: {} };
        repo.files = repo.files || [];
        const existingIndex = repo.files.findIndex(f => f.name === fileName);
        if (existingIndex >= 0) {
          pushFileVersion(repo.files[existingIndex]);
          await deleteStoredFileObject(env, repo.files[existingIndex]);
          fileData.versions = repo.files[existingIndex].versions || [];
          repo.files[existingIndex] = fileData;
        } else repo.files.push(fileData);
        await saveRepo(env, repoId, repo);
        return jsonResponse(fileData);
      }

      if (path.match(/^\/api\/files\/[^\/]+$/) && method === 'GET') {
        const fileId = path.split('/')[3];
        const found = await findRepoByFile(env, fileId);
        if (!found) return jsonResponse({ error: 'File not found' }, 404);
        if (!canAccessRepo(found.repo, user)) return jsonResponse({ error: 'Private file' }, 403);
        let content = found.file.content || '';
        if (found.file.isText !== false && !content) {
          try { content = new TextDecoder().decode(await getFileBytes(env, found.file)); } catch (_) {}
        }
        return jsonResponse({ ...found.file, content, repoId: found.repoId, rawUrl: `/raw/${fileId}`, downloadUrl: `/raw/${fileId}?download=1` });
      }

      if (path.match(/^\/api\/files\/[^\/]+$/) && method === 'PUT') {
        const fileId = path.split('/')[3];
        const data = await request.json();
        const found = await findRepoByFile(env, fileId);
        if (!found) return jsonResponse({ error: 'File not found' }, 404);
        if (!canAccessRepo(found.repo, user)) return jsonResponse({ error: 'Forbidden' }, 403);
        const idx = found.repo.files.findIndex(f => f.id === fileId);
        const oldFile = found.repo.files[idx];
        pushFileVersion(oldFile);
        const fileName = sanitizePath(data.name || oldFile.name || 'file.txt');
        await deleteStoredFileObject(env, oldFile);
        const content = String(data.content ?? '');
        found.repo.files[idx] = { ...oldFile, name: fileName, content, encoding: undefined, storageKey: undefined, isText: true, language: data.language || getLanguageFromName(fileName), mimeType: getMimeType(fileName), updated: nowIso(), size: content.length, securityWarnings: scanTextSecrets(fileName, content), versions: oldFile.versions || [], stats: oldFile.stats || {} };
        await saveRepo(env, found.repoId, found.repo);
        return jsonResponse(found.repo.files[idx]);
      }

      if (path.match(/^\/api\/files\/[^\/]+\/versions$/) && method === 'GET') {
        const fileId = path.split('/')[3];
        const found = await findRepoByFile(env, fileId);
        if (!found) return jsonResponse({ error: 'File not found' }, 404);
        if (!canAccessRepo(found.repo, user)) return jsonResponse({ error: 'Private file' }, 403);
        return jsonResponse({ versions: found.file.versions || [] });
      }

      if (path.match(/^\/api\/files\/[^\/]+\/versions\/[^\/]+\/restore$/) && method === 'POST') {
        const parts = path.split('/');
        const fileId = parts[3], versionId = parts[5];
        const found = await findRepoByFile(env, fileId);
        if (!found) return jsonResponse({ error: 'File not found' }, 404);
        if (!canAccessRepo(found.repo, user)) return jsonResponse({ error: 'Forbidden' }, 403);
        const idx = found.repo.files.findIndex(f => f.id === fileId);
        const file = found.repo.files[idx];
        const version = (file.versions || []).find(v => v.id === versionId);
        if (!version) return jsonResponse({ error: 'Version not found' }, 404);
        pushFileVersion(file);
        found.repo.files[idx] = { ...file, name: version.name || file.name, content: version.content || '', language: version.language || file.language, mimeType: version.mimeType || file.mimeType, isText: true, encoding: undefined, storageKey: undefined, updated: nowIso(), size: String(version.content || '').length };
        await saveRepo(env, found.repoId, found.repo);
        return jsonResponse(found.repo.files[idx]);
      }

      if (path.match(/^\/api\/files\/[^\/]+$/) && method === 'DELETE') {
        const fileId = path.split('/')[3];
        const found = await findRepoByFile(env, fileId);
        if (!found) return jsonResponse({ error: 'File not found' }, 404);
        if (!canAccessRepo(found.repo, user)) return jsonResponse({ error: 'Forbidden' }, 403);
        const idx = found.repo.files.findIndex(f => f.id === fileId);
        const deleted = found.repo.files.splice(idx, 1)[0];
        deleted.deletedAt = nowIso();
        found.repo.trashFiles = found.repo.trashFiles || [];
        found.repo.trashFiles.unshift(deleted);
        await saveRepo(env, found.repoId, found.repo);
        return jsonResponse({ success: true, file: deleted, trash: true });
      }

      if (path.match(/^\/api\/repos\/[^\/]+\/trash$/) && method === 'GET') {
        const repoId = path.split('/')[3];
        const repo = await loadRepo(env, repoId);
        if (!repo) return jsonResponse({ error: 'Repository not found' }, 404);
        if (!canAccessRepo(repo, user)) return jsonResponse({ error: 'Forbidden' }, 403);
        return jsonResponse({ files: repo.trashFiles || [] });
      }

      if (path.match(/^\/api\/repos\/[^\/]+\/trash\/[^\/]+\/restore$/) && method === 'POST') {
        const parts = path.split('/');
        const repoId = parts[3], fileId = parts[5];
        const repo = await loadRepo(env, repoId);
        if (!repo) return jsonResponse({ error: 'Repository not found' }, 404);
        if (!canAccessRepo(repo, user)) return jsonResponse({ error: 'Forbidden' }, 403);
        const idx = (repo.trashFiles || []).findIndex(f => f.id === fileId);
        if (idx < 0) return jsonResponse({ error: 'Trash file not found' }, 404);
        const file = repo.trashFiles.splice(idx, 1)[0];
        delete file.deletedAt;
        repo.files = repo.files || [];
        const nameConflict = repo.files.find(f => f.name === file.name);
        if (nameConflict) file.name = file.name.replace(/(\.[^/.]+)?$/, `-restored-${Date.now()}$1`);
        repo.files.push(file);
        await saveRepo(env, repoId, repo);
        return jsonResponse({ success: true, file });
      }

      if (path.match(/^\/api\/repos\/[^\/]+\/trash\/[^\/]+$/) && method === 'DELETE') {
        const parts = path.split('/');
        const repoId = parts[3], fileId = parts[5];
        const repo = await loadRepo(env, repoId);
        if (!repo) return jsonResponse({ error: 'Repository not found' }, 404);
        if (!canAccessRepo(repo, user)) return jsonResponse({ error: 'Forbidden' }, 403);
        const idx = (repo.trashFiles || []).findIndex(f => f.id === fileId);
        if (idx < 0) return jsonResponse({ error: 'Trash file not found' }, 404);
        const file = repo.trashFiles.splice(idx, 1)[0];
        await deleteStoredFileObject(env, file);
        await saveRepo(env, repoId, repo);
        return jsonResponse({ success: true });
      }

      if (path.match(/^\/api\/repos\/[^\/]+$/) && method === 'DELETE') {
        const repoId = path.split('/')[3];
        const repo = await loadRepo(env, repoId);
        if (!repo) return jsonResponse({ error: 'Repository not found' }, 404);
        if (!canAccessRepo(repo, user)) return jsonResponse({ error: 'Forbidden' }, 403);
        await r2Put(env, `trash:repo:${repoId}`, JSON.stringify({ repo, deletedAt: nowIso(), deletedBy: user?.username || 'admin' }));
        await r2Delete(env, `repo:${repoId}`);
        return jsonResponse({ success: true, trash: true });
      }

      if (path.match(/^\/api\/repos\/[^\/]+\/readme$/) && method === 'GET') {
        const repoId = path.split('/')[3];
        const repo = await loadRepo(env, repoId);
        if (!repo) return jsonResponse({ error: 'Repository not found' }, 404);
        if (!canAccessRepo(repo, user)) return jsonResponse({ error: 'Private repository' }, 403);
        return jsonResponse(repo.readme || { content: '# ' + repo.name + '\n\n' + (repo.description || 'No description provided'), lastUpdated: repo.created });
      }

      if (path.match(/^\/api\/repos\/[^\/]+\/readme$/) && method === 'PUT') {
        const repoId = path.split('/')[3];
        const data = await request.json();
        const repo = await loadRepo(env, repoId);
        if (!repo) return jsonResponse({ error: 'Repository not found' }, 404);
        if (!canAccessRepo(repo, user)) return jsonResponse({ error: 'Forbidden' }, 403);
        repo.readme = { content: data.content || '', lastUpdated: nowIso(), securityWarnings: scanTextSecrets('README.md', data.content || '') };
        await saveRepo(env, repoId, repo);
        return jsonResponse(repo.readme);
      }

      if (path === '/api/upload-multiple' && method === 'POST') {
        const formData = await request.formData();
        const repoId = formData.get('repoId');
        const folder = sanitizePath(formData.get('folder') || '', '');
        const files = formData.getAll('files');
        if (!repoId || files.length === 0) return jsonResponse({ error: 'Repository ID and files are required' }, 400);
        const repo = await loadRepo(env, repoId);
        if (!repo) return jsonResponse({ error: 'Repository not found' }, 404);
        if (!canAccessRepo(repo, user)) return jsonResponse({ error: 'Forbidden' }, 403);
        repo.files = repo.files || [];
        const uploadedFiles = [], errors = [];
        for (const file of files) {
          try {
            const originalName = sanitizePath(file.name || 'uploaded-file.txt');
            const fileName = folder ? `${folder.replace(/\/$/, '')}/${originalName}` : originalName;
            const mimeType = file.type || getMimeType(fileName);
            const isText = isTextMime(mimeType, fileName);
            const fileId = generateId();
            const fileData = { id: fileId, name: fileName, language: getLanguageFromName(fileName), mimeType, isText, created: nowIso(), updated: nowIso(), size: file.size, stats: {}, versions: [] };
            if (isText) {
              fileData.content = await file.text();
              fileData.securityWarnings = scanTextSecrets(fileName, fileData.content);
            } else {
              const fileBytes = new Uint8Array(await file.arrayBuffer());
              const storageKey = storageKeyForFile(fileId);
              await r2Put(env, storageKey, fileBytes, { httpMetadata: { contentType: mimeType }, customMetadata: { filename: fileName, repoId, isText: 'false' } });
              fileData.encoding = 'r2';
              fileData.storageKey = storageKey;
              attachBinaryBackup(fileData, fileBytes);
            }
            const existingIndex = repo.files.findIndex(f => f.name === fileName);
            if (existingIndex >= 0) {
              pushFileVersion(repo.files[existingIndex]);
              await deleteStoredFileObject(env, repo.files[existingIndex]);
              fileData.versions = repo.files[existingIndex].versions || [];
              repo.files[existingIndex] = fileData;
            } else repo.files.push(fileData);
            uploadedFiles.push(fileData);
          } catch (error) { errors.push({ name: file.name, error: error.message }); }
        }
        await saveRepo(env, repoId, repo);
        return jsonResponse({ success: true, uploaded: uploadedFiles.length, uploadedFiles, errors, warnings: uploadedFiles.flatMap(f => f.securityWarnings || []) });
      }

      if (path.match(/^\/api\/repos\/[^\/]+\/releases$/) && method === 'GET') {
        const repoId = path.split('/')[3];
        const repo = await loadRepo(env, repoId);
        if (!repo) return jsonResponse({ error: 'Repository not found' }, 404);
        if (!canAccessRepo(repo, user)) return jsonResponse({ error: 'Private repository' }, 403);
        return jsonResponse({ releases: repo.releases || [] });
      }

      if (path.match(/^\/api\/repos\/[^\/]+\/releases$/) && method === 'POST') {
        const repoId = path.split('/')[3];
        const data = await request.json();
        const repo = await loadRepo(env, repoId);
        if (!repo) return jsonResponse({ error: 'Repository not found' }, 404);
        if (!canAccessRepo(repo, user)) return jsonResponse({ error: 'Forbidden' }, 403);
        const release = { id: generateId(), version: sanitizePath(data.version || `v${new Date().toISOString().slice(0,10)}`).replace(/\//g,'-'), title: data.title || data.version || 'Release', notes: data.notes || '', fileIds: normalizeStringList(data.fileIds), downloads: 0, created: nowIso(), updated: nowIso() };
        repo.releases = repo.releases || [];
        repo.releases.unshift(release);
        await saveRepo(env, repoId, repo);
        return jsonResponse(release);
      }

      if (path.match(/^\/api\/repos\/[^\/]+\/releases\/[^\/]+$/) && (method === 'PUT' || method === 'DELETE')) {
        const parts = path.split('/');
        const repoId = parts[3], releaseId = parts[5];
        const repo = await loadRepo(env, repoId);
        if (!repo) return jsonResponse({ error: 'Repository not found' }, 404);
        if (!canAccessRepo(repo, user)) return jsonResponse({ error: 'Forbidden' }, 403);
        const idx = (repo.releases || []).findIndex(r => r.id === releaseId);
        if (idx < 0) return jsonResponse({ error: 'Release not found' }, 404);
        if (method === 'DELETE') {
          const deleted = repo.releases.splice(idx, 1)[0];
          await saveRepo(env, repoId, repo);
          return jsonResponse({ success: true, release: deleted });
        }
        const data = await request.json();
        repo.releases[idx] = { ...repo.releases[idx], version: data.version || repo.releases[idx].version, title: data.title || repo.releases[idx].title, notes: data.notes ?? repo.releases[idx].notes, fileIds: data.fileIds !== undefined ? normalizeStringList(data.fileIds) : repo.releases[idx].fileIds, updated: nowIso() };
        await saveRepo(env, repoId, repo);
        return jsonResponse(repo.releases[idx]);
      }

      if (path.match(/^\/api\/repos\/[^\/]+\/shares$/) && method === 'GET') {
        const repoId = path.split('/')[3];
        const repo = await loadRepo(env, repoId);
        if (!repo) return jsonResponse({ error: 'Repository not found' }, 404);
        if (!canAccessRepo(repo, user)) return jsonResponse({ error: 'Forbidden' }, 403);
        return jsonResponse({ shares: (repo.shares || []).map(s => ({ ...s, password: s.password ? '••••••' : '' })) });
      }

      if (path.match(/^\/api\/repos\/[^\/]+\/shares$/) && method === 'POST') {
        const repoId = path.split('/')[3];
        const data = await request.json();
        const repo = await loadRepo(env, repoId);
        if (!repo) return jsonResponse({ error: 'Repository not found' }, 404);
        if (!canAccessRepo(repo, user)) return jsonResponse({ error: 'Forbidden' }, 403);
        const expiresHours = Number(data.expiresHours || 0);
        const share = { id: generateId(), type: data.type === 'file' ? 'file' : 'repo', targetId: data.targetId || '', password: data.password || '', expiresAt: expiresHours > 0 ? new Date(Date.now() + expiresHours * 3600 * 1000).toISOString() : '', maxDownloads: Number(data.maxDownloads || 0), downloads: 0, hits: 0, created: nowIso() };
        repo.shares = repo.shares || [];
        repo.shares.unshift(share);
        await saveRepo(env, repoId, repo);
        return jsonResponse({ ...share, password: share.password ? '••••••' : '', shareUrl: `/s/${share.id}`, absoluteShareUrl: `${new URL(request.url).origin}/s/${share.id}` });
      }

      if (path.match(/^\/api\/repos\/[^\/]+\/shares\/[^\/]+$/) && method === 'DELETE') {
        const parts = path.split('/');
        const repoId = parts[3], shareId = parts[5];
        const repo = await loadRepo(env, repoId);
        if (!repo) return jsonResponse({ error: 'Repository not found' }, 404);
        if (!canAccessRepo(repo, user)) return jsonResponse({ error: 'Forbidden' }, 403);
        repo.shares = (repo.shares || []).filter(s => s.id !== shareId);
        await saveRepo(env, repoId, repo);
        return jsonResponse({ success: true });
      }

      return jsonResponse({ error: 'Not found' }, 404);
    } catch (error) {
      console.error('API error:', error);
      return jsonResponse({ error: 'Internal server error: ' + error.message }, 500);
    }
  }


  // Login page HTML
function serveLoginPage(env = {}) {
    const usingEnv = !!(env.ADMIN_USER || env.ADMIN_PASS);
    const html = `<!DOCTYPE html>
  <html lang="id">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🔐 Login - CodeHub V5.4 Final Pro</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}body{min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:radial-gradient(circle at 10% 10%,rgba(88,166,255,.24),transparent 28%),radial-gradient(circle at 90% 0%,rgba(163,113,247,.22),transparent 34%),#050814;color:#f0f6fc;display:flex;align-items:center;justify-content:center;padding:22px}.card{width:100%;max-width:430px;background:linear-gradient(180deg,rgba(22,27,34,.92),rgba(13,17,23,.88));border:1px solid rgba(139,148,158,.22);border-radius:28px;padding:28px;box-shadow:0 28px 80px rgba(0,0,0,.38);backdrop-filter:blur(18px)}.brand{text-align:center;margin-bottom:22px}.logo{font-size:42px;margin-bottom:8px}.title{font-size:26px;font-weight:900;letter-spacing:-.04em;background:linear-gradient(90deg,#58a6ff,#a371f7,#f778ba);-webkit-background-clip:text;color:transparent}.subtitle{color:#8b949e;font-size:14px;margin-top:6px;line-height:1.5}.group{margin:18px 0}label{display:block;font-size:13px;color:#c9d1d9;margin-bottom:8px;font-weight:700}input{width:100%;padding:14px 15px;border-radius:16px;background:rgba(5,8,20,.72);border:1px solid rgba(139,148,158,.22);color:#f0f6fc;font-size:16px;outline:none}input:focus{border-color:#58a6ff;box-shadow:0 0 0 4px rgba(88,166,255,.10)}button{width:100%;border:0;border-radius:16px;padding:14px 18px;background:linear-gradient(135deg,#238636,#2ea043);color:white;font-weight:900;font-size:15px;cursor:pointer;box-shadow:0 14px 30px rgba(35,134,54,.25)}button:hover{filter:brightness(1.07)}.note{margin-top:18px;padding:14px;border-radius:18px;background:rgba(88,166,255,.08);border:1px solid rgba(88,166,255,.20);color:#8b949e;font-size:13px;line-height:1.55}.err{display:none;margin-bottom:16px;padding:12px;border-radius:16px;background:rgba(248,81,73,.12);border:1px solid rgba(248,81,73,.35);color:#ffb4ad;font-size:14px}.back{display:block;text-align:center;margin-top:18px;color:#58a6ff;text-decoration:none;font-size:14px}
    </style>
  </head>
  <body>
    <div class="card">
      <div class="brand"><div class="logo">🚀</div><div class="title">CodeHub V5.4 Final Pro</div><div class="subtitle">Repository R2 dengan ZIP, Git clone, private repo, preview, search, dan PWA.</div></div>
      <div id="error" class="err"></div>
      <form onsubmit="login(event)">
        <div class="group"><label>👤 Username</label><input id="username" autocomplete="username" required placeholder="admin"></div>
        <div class="group"><label>🔑 Password</label><input id="password" type="password" autocomplete="current-password" required placeholder="••••••••"></div>
        <button type="submit">🔐 Masuk Dashboard</button>
      </form>
      <div class="note">🛡️ V4 sudah support ENV: <b>ADMIN_USER</b> dan <b>ADMIN_PASS</b>. ${usingEnv ? 'Akun login sedang memakai ENV.' : 'Kalau ENV belum diisi, default tetap admin / admin123.'}</div>
      <a class="back" href="/">← Kembali ke public repo</a>
    </div>
    <script>
      async function login(e){e.preventDefault();const error=document.getElementById('error');error.style.display='none';try{const res=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('username').value,password:document.getElementById('password').value})});const data=await res.json();if(res.ok){location.href='/'}else{error.textContent=data.error||'Login gagal';error.style.display='block'}}catch(err){error.textContent='Login gagal. Coba lagi.';error.style.display='block'}}
    </script>
  </body>
  </html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  
  // Serve main HTML untuk dashboard
function serveHTML(env, isAuthenticated, user) {
    if (!isAuthenticated) return new Response('', { status: 302, headers: { 'Location': '/login' } });
    const html = `<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>🚀 CodeHub V5.4 Final Pro Dashboard</title><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#050814"><style>${sharedV4Css()}</style></head><body><header><div class="wrap nav"><a class="brand" href="/">🚀 CodeHub <span>V5.4 Final Pro</span></a><div class="nav-actions"><button class="btn ghost" onclick="setTheme('dark')">🌑 Dark</button><button class="btn ghost" onclick="setTheme('purple')">💜 Purple</button><button class="btn ghost" onclick="setTheme('green')">🟢 Hacker</button><button class="btn ghost" onclick="openTrashRepos()">🗑️ Trash</button><button class="btn ghost" onclick="installPWA()">📱 Install</button><button class="btn ghost" onclick="loadRepos()">🔄 Refresh</button><button class="btn danger" onclick="logout()">🚪 Logout</button></div></div></header><main class="wrap"><section id="home"><section class="hero"><div><div class="pill">👋 Welcome, ${escapeHtml(user.username)}</div><h1>⚡ CodeHub Final Pro untuk R2 kamu.</h1><p>Release Manager, statistik, share password/expired, trash restore, version history, folder tree, content search, Git URL ala GitHub, dan ZIP binary-safe.</p></div><div class="hero-stat"><b id="statRepo">0</b><span>Repo</span><b id="statFile">0</b><span>File</span></div></section><section class="toolbar"><h2>📦 Repositories</h2><div class="nav-actions"><input id="repoSearch" class="search" oninput="renderRepos()" placeholder="🔎 Cari repo..."><button class="btn" onclick="openRepoModal()">➕ New Repo</button></div></section><section id="repoGrid" class="grid"></section></section><section id="detail" style="display:none"><button class="btn ghost" onclick="backHome()">← Back</button><div id="detailBox"></div></section></main><div id="repoModal" class="modal"><div class="modal-card"><div class="modal-head"><h2 id="repoModalTitle">➕ Repository</h2><button class="close" onclick="closeModal('repoModal')">✕</button></div><div class="form-grid"><div><div class="label">📦 Nama Repo</div><input id="repoName" placeholder="my-project"></div><div><div class="label">📝 Deskripsi</div><input id="repoDesc" placeholder="Deskripsi singkat"></div><div><div class="label">🔐 Visibility</div><select id="repoVisibility"><option value="public">🌍 Public</option><option value="private">🔒 Private</option></select></div><button class="btn" onclick="saveRepo()">💾 Save Repo</button></div></div></div><div id="fileModal" class="modal"><div class="modal-card"><div class="modal-head"><h2 id="fileModalTitle">📄 File</h2><button class="close" onclick="closeModal('fileModal')">✕</button></div><div class="form-grid"><div><div class="label">📁 Path / Nama File</div><input id="fileNameInput" placeholder="src/index.js atau README.md"></div><div><div class="label">🧠 Language</div><input id="fileLangInput" placeholder="auto / javascript / html / text"></div><div><div class="label">📝 Content</div><textarea id="fileContentInput" placeholder="Tulis isi file di sini..."></textarea></div><button class="btn" onclick="saveFile()">💾 Save File</button></div></div></div><div id="readmeModal" class="modal"><div class="modal-card"><div class="modal-head"><h2>📘 README.md</h2><button class="close" onclick="closeModal('readmeModal')">✕</button></div><textarea id="readmeInput"></textarea><br><br><button class="btn" onclick="saveReadme()">💾 Save README</button></div></div><div id="viewModal" class="modal"><div class="modal-card"><div class="modal-head"><h2 id="viewTitle">👁️ Preview</h2><button class="close" onclick="closeModal('viewModal')">✕</button></div><div id="previewBox"></div></div></div><div id="releaseModal" class="modal"><div class="modal-card"><div class="modal-head"><h2>🚀 Release</h2><button class="close" onclick="closeModal('releaseModal')">✕</button></div><div class="form-grid"><div><div class="label">🏷️ Version</div><input id="releaseVersion" placeholder="v1.0.0"></div><div><div class="label">📌 Title</div><input id="releaseTitle" placeholder="Initial Release"></div><div><div class="label">📦 File IDs / pilih dari daftar</div><input id="releaseFileIds" placeholder="fileId1,fileId2"></div><div><div class="label">📝 Changelog</div><textarea id="releaseNotes" placeholder="Apa yang berubah?"></textarea></div><button class="btn" onclick="saveRelease()">🚀 Publish Release</button></div></div></div><div id="shareModal" class="modal"><div class="modal-card"><div class="modal-head"><h2>🔗 Share Link</h2><button class="close" onclick="closeModal('shareModal')">✕</button></div><div class="form-grid"><div><div class="label">🎯 Type</div><select id="shareType"><option value="repo">📦 Repository</option><option value="file">📄 File</option></select></div><div><div class="label">📄 Target File ID jika type file</div><input id="shareTarget" placeholder="kosongkan untuk repo"></div><div><div class="label">🔐 Password opsional</div><input id="sharePass" placeholder="boleh kosong"></div><div><div class="label">⏳ Expired dalam jam</div><input id="shareHours" type="number" placeholder="0 = tidak expired"></div><div><div class="label">🔢 Max download</div><input id="shareMax" type="number" placeholder="0 = unlimited"></div><button class="btn" onclick="saveShare()">🔗 Buat Share Link</button></div></div></div><div id="trashModal" class="modal"><div class="modal-card"><div class="modal-head"><h2>🗑️ Trash</h2><button class="close" onclick="closeModal('trashModal')">✕</button></div><div id="trashBox"></div></div></div><div id="historyModal" class="modal"><div class="modal-card"><div class="modal-head"><h2>🕘 Version History</h2><button class="close" onclick="closeModal('historyModal')">✕</button></div><div id="historyBox"></div></div></div><input id="uploadInput" type="file" multiple style="display:none" onchange="uploadSelected(event)"><script>${dashboardV5FinalScript()}</script></body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  function dashboardV5FinalScript() {
    return String.raw`var repos=[],currentRepo=null,currentFile=null,currentRelease=null,deferredInstall=null;window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();deferredInstall=e});if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(function(){})}document.addEventListener('DOMContentLoaded',function(){document.body.dataset.theme=localStorage.codehubTheme||'dark';loadRepos()});function esc(s){return String(s||'').replace(/[&<>"']/g,function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]})}function toast(m){var d=document.createElement('div');d.className='toast';d.textContent=m;document.body.appendChild(d);setTimeout(function(){d.remove()},3200)}function setTheme(t){document.body.dataset.theme=t;localStorage.codehubTheme=t;toast('🎨 Tema: '+t)}function icon(f){var l=(f.language||'').toLowerCase(),n=(f.name||'').toLowerCase();if(l.includes('javascript')||n.endsWith('.js'))return '📜';if(l.includes('python')||n.endsWith('.py'))return '🐍';if(l.includes('html'))return '🌐';if(l.includes('css'))return '🎨';if(l.includes('image')||/\.(png|jpg|jpeg|gif|webp|svg|avif)$/.test(n))return '🖼️';if(n.endsWith('.pdf'))return '📕';if(/\.(zip|rar|7z|apk|jar|exe)$/.test(n))return '📦';if(l.includes('markdown')||n.endsWith('.md'))return '📝';return '📄'}async function api(url,opt){var r=await fetch(url,opt||{});var t=await r.text();var d;try{d=JSON.parse(t)}catch(e){d={error:t}}if(!r.ok)throw new Error(d.error||'Request error');return d}async function loadRepos(){try{repos=await api('/api/repos');document.getElementById('statRepo').textContent=repos.length;document.getElementById('statFile').textContent=repos.reduce(function(t,r){return t+(r.files?r.files.length:0)},0);renderRepos()}catch(e){toast('❌ '+e.message)}}function renderRepos(){var q=(document.getElementById('repoSearch').value||'').toLowerCase();var list=repos.filter(function(r){return ((r.name||'')+' '+(r.description||'')+' '+(r.visibility||'')).toLowerCase().indexOf(q)>-1});document.getElementById('repoGrid').innerHTML=list.length?list.map(function(r){var s=r.stats||{};return '<div class="repo-card" onclick="openRepo(\''+r.id+'\')"><div class="card-icon">'+(r.visibility==='private'?'🔒':'📦')+'</div><h3>'+esc(r.name)+'</h3><p>'+esc(r.description||'No description')+'</p><div class="meta"><span>📄 '+(r.files?r.files.length:0)+' file</span><span>'+(r.visibility==='private'?'🔒 Private':'🌍 Public')+'</span><span>👁️ '+(s.views||0)+'</span><span>📦 '+(s.zipDownloads||0)+'</span></div></div>'}).join(''):'<div class="empty">📭 Belum ada repo.</div>'}function backHome(){document.getElementById('home').style.display='block';document.getElementById('detail').style.display='none';loadRepos()}async function openRepo(id){currentRepo=await api('/api/repos/'+id);document.getElementById('home').style.display='none';document.getElementById('detail').style.display='block';renderDetail()}function slugName(s){return String(s||'repository').toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'')||'repository'}function renderDetail(){var r=currentRepo,abs=r.absolutePublicUrl||location.origin+'/'+slugName(r.name),git=r.absoluteGitUrl||location.origin+'/'+slugName(r.name)+'.git';var files=r.files||[],stats=r.stats||{};document.getElementById('detailBox').innerHTML='<section class="repo-hero"><div><div class="pill">'+(r.visibility==='private'?'🔒 Private':'🌍 Public')+'</div><h1>📦 '+esc(r.name)+'</h1><p>'+esc(r.description||'No description')+'</p><div class="meta big"><span>📄 '+files.length+' file</span><span>👁️ '+(stats.views||0)+' views</span><span>📥 '+(stats.fileDownloads||0)+' file downloads</span><span>📦 '+(stats.zipDownloads||0)+' zip</span><span>🧬 '+(stats.gitClones||0)+' git</span></div></div></section><section class="panel"><h2>🔗 Link & Export</h2><div class="linkbox"><input id="pubUrl" value="'+abs+'" readonly><button onclick="copyInput(\'pubUrl\')">📋 Copy Public</button></div><div class="linkbox"><input id="gitUrl" value="'+git+'" readonly><button onclick="copyInput(\'gitUrl\')">📋 Copy Git</button></div><div class="row-actions"><button class="btn" onclick="downloadZip()">📦 Download ZIP</button><button class="btn ghost" onclick="editRepo()">✏️ Edit Info</button><button class="btn ghost" onclick="openReadme()">📘 README</button><button class="btn ghost" onclick="newFile()">➕ Add File</button><button class="btn ghost" onclick="pickUpload()">📤 Upload</button><button class="btn ghost" onclick="importUrl()">🌐 Import URL</button><button class="btn ghost" onclick="globalSearch()">🔎 Search Isi</button><button class="btn ghost" onclick="openReleaseModal()">🚀 New Release</button><button class="btn ghost" onclick="openShareModal()">🔗 Share</button><button class="btn ghost" onclick="openTrashFiles()">🗑️ Trash File</button><button class="btn danger" onclick="deleteRepo()">🗑️ Delete Repo</button></div></section><section class="toolbar"><h2>📁 Files</h2><input id="fileSearch" class="search" oninput="renderFiles()" placeholder="🔎 Cari file/folder..."></section><section id="filesBox" class="file-list"></section><section class="panel"><h2>🚀 Releases</h2><div id="releaseBox"></div></section><section class="panel"><h2>🔗 Share Links</h2><div id="shareBox"></div></section><section class="panel readme"><h2>📘 README.md</h2><article>'+renderMd((r.readme&&r.readme.content)||('# '+r.name+'\\n\\n'+(r.description||'')))+'</article></section>';renderFiles();renderReleases();renderShares()}function folderTreeRows(files){files=files.slice().sort(function(a,b){return String(a.name).localeCompare(String(b.name))});var rows=[],seen={};files.forEach(function(f){var parts=String(f.name||'').split('/');var path='';for(var i=0;i<parts.length-1;i++){path+=(path?'/':'')+parts[i];if(!seen[path]){seen[path]=1;rows.push({folder:true,name:path,depth:i})}}rows.push({file:f,depth:Math.max(0,parts.length-1)})});return rows}function renderFiles(){var q=(document.getElementById('fileSearch')&&document.getElementById('fileSearch').value||'').toLowerCase(),files=(currentRepo.files||[]).filter(function(f){return ((f.name||'')+' '+(f.language||'')+' '+((f.securityWarnings||[]).join(' '))).toLowerCase().indexOf(q)>-1});var rows=folderTreeRows(files);document.getElementById('filesBox').innerHTML=rows.length?rows.map(function(row){if(row.folder)return '<div class="folder-row" style="padding-left:'+(12+row.depth*18)+'px">📁 <b>'+esc(row.name)+'</b></div>';var f=row.file,w=(f.securityWarnings||[]).length?' <small class="warn">⚠️ secret?</small>':'';return '<div class="file-row" style="margin-left:'+(row.depth*18)+'px"><div class="file-main"><span>'+icon(f)+'</span><b>'+esc(f.name)+'</b><small>'+esc(f.language||'text')+'</small>'+w+'</div><div class="file-actions"><button onclick="viewFile(\''+f.id+'\')">👁️ View</button><button onclick="editFile(\''+f.id+'\')">✏️ Edit</button><button onclick="showHistory(\''+f.id+'\')">🕘 History</button><a href="/raw/'+f.id+'" target="_blank">👁️ Raw</a><button onclick="downloadFile(\''+f.id+'\',\''+esc(f.name)+'\')">📥 Download</button><button onclick="copyUrl(location.origin+\'/raw/'+f.id+'\')">📋 Copy Raw</button><button class="danger" onclick="deleteFile(\''+f.id+'\')">🗑️</button></div></div>'}).join(''):'<div class="empty">📭 Belum ada file.</div>'}function renderReleases(){var rel=currentRepo.releases||[];document.getElementById('releaseBox').innerHTML=rel.length?rel.map(function(r){return '<div class="file-row"><div class="file-main"><span>🚀</span><b>'+esc(r.version)+' — '+esc(r.title||'Release')+'</b><small>📥 '+(r.downloads||0)+'</small></div><div class="file-actions"><a href="/release/'+currentRepo.id+'/'+r.id+'">📦 Download</a><button onclick="copyUrl(location.origin+\'/release/'+currentRepo.id+'/'+r.id+'\')">📋 Copy Release</button><button class="danger" onclick="deleteRelease(\''+r.id+'\')">🗑️</button></div></div><pre>'+esc(r.notes||'')+'</pre>'}).join(''):'<div class="empty">🚀 Belum ada release.</div>'}function renderShares(){var shares=currentRepo.shares||[];document.getElementById('shareBox').innerHTML=shares.length?shares.map(function(s){return '<div class="file-row"><div class="file-main"><span>🔗</span><b>'+esc(s.type)+' '+esc(s.targetId||currentRepo.name)+'</b><small>hits '+(s.hits||0)+' / dl '+(s.downloads||0)+'</small></div><div class="file-actions"><button onclick="copyUrl(location.origin+\'/s/'+s.id+'\')">📋 Copy</button><button class="danger" onclick="deleteShare(\''+s.id+'\')">🗑️</button></div></div>'}).join(''):'<div class="empty">🔗 Belum ada share link.</div>'}function openRepoModal(){currentRepo=null;document.getElementById('repoModalTitle').textContent='➕ New Repository';document.getElementById('repoName').value='';document.getElementById('repoDesc').value='';document.getElementById('repoVisibility').value='public';showModal('repoModal')}function editRepo(){document.getElementById('repoModalTitle').textContent='✏️ Edit Repository';document.getElementById('repoName').value=currentRepo.name||'';document.getElementById('repoDesc').value=currentRepo.description||'';document.getElementById('repoVisibility').value=currentRepo.visibility||'public';showModal('repoModal')}async function saveRepo(){var body={name:document.getElementById('repoName').value,description:document.getElementById('repoDesc').value,visibility:document.getElementById('repoVisibility').value};try{if(currentRepo){await api('/api/repos/'+currentRepo.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});closeModal('repoModal');await openRepo(currentRepo.id);toast('✅ Repo diperbarui')}else{var r=await api('/api/repos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});closeModal('repoModal');await loadRepos();await openRepo(r.id);toast('✅ Repo dibuat')}}catch(e){toast('❌ '+e.message)}}function newFile(){currentFile=null;document.getElementById('fileModalTitle').textContent='➕ Add File';document.getElementById('fileNameInput').value='src/index.js';document.getElementById('fileLangInput').value='';document.getElementById('fileContentInput').value='';showModal('fileModal')}async function editFile(id){currentFile=await api('/api/files/'+id);document.getElementById('fileModalTitle').textContent='✏️ Edit File';document.getElementById('fileNameInput').value=currentFile.name||'';document.getElementById('fileLangInput').value=currentFile.language||'';document.getElementById('fileContentInput').value=currentFile.content||'';showModal('fileModal')}async function saveFile(){var body={name:document.getElementById('fileNameInput').value,language:document.getElementById('fileLangInput').value,content:document.getElementById('fileContentInput').value};try{var res;if(currentFile){res=await api('/api/files/'+currentFile.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}else{res=await api('/api/repos/'+currentRepo.id+'/files',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}closeModal('fileModal');await openRepo(currentRepo.id);toast((res.securityWarnings&&res.securityWarnings.length)?'⚠️ File tersimpan, ada warning secret':'✅ File tersimpan')}catch(e){toast('❌ '+e.message)}}async function viewFile(id){var f=await api('/api/files/'+id),raw='/raw/'+id,n=(f.name||'').toLowerCase(),html='';document.getElementById('viewTitle').textContent='👁️ '+f.name;if(/\.(png|jpg|jpeg|gif|webp|svg|avif)$/.test(n))html='<img class="preview-img" src="'+raw+'">';else if(n.endsWith('.pdf'))html='<iframe class="preview-frame" src="'+raw+'"></iframe>';else if(/\.(mp4|webm|mov)$/.test(n))html='<video class="preview-img" controls src="'+raw+'"></video>';else if(/\.(mp3|wav|ogg|flac|m4a)$/.test(n))html='<audio controls src="'+raw+'" style="width:100%"></audio>';else if(/\.(html|htm)$/.test(n))html='<iframe class="preview-frame" sandbox src="'+raw+'"></iframe>';else html='<pre>'+esc(f.content || 'Binary/non-text file. Gunakan Raw atau Download untuk membuka file asli.')+'</pre>';if((f.securityWarnings||[]).length)html='<div class="warnbox">⚠️ '+esc(f.securityWarnings.join(', '))+'</div>'+html;document.getElementById('previewBox').innerHTML=html;showModal('viewModal')}async function deleteFile(id){if(!confirm('Pindahkan file ke Trash?'))return;await api('/api/files/'+id,{method:'DELETE'});await openRepo(currentRepo.id);toast('🗑️ File masuk Trash')}async function deleteRepo(){if(!confirm('Pindahkan repository ke Trash?'))return;await api('/api/repos/'+currentRepo.id,{method:'DELETE'});backHome();toast('🗑️ Repo masuk Trash')}function openReadme(){document.getElementById('readmeInput').value=(currentRepo.readme&&currentRepo.readme.content)||('# '+currentRepo.name+'\n\n'+(currentRepo.description||''));showModal('readmeModal')}async function saveReadme(){await api('/api/repos/'+currentRepo.id+'/readme',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:document.getElementById('readmeInput').value})});closeModal('readmeModal');await openRepo(currentRepo.id);toast('📘 README tersimpan')}function pickUpload(){document.getElementById('uploadInput').click()}async function uploadSelected(e){var folder=prompt('Upload ke folder/path apa? Kosongkan untuk root.','');var fd=new FormData();fd.append('repoId',currentRepo.id);fd.append('folder',folder||'');Array.from(e.target.files).forEach(function(f){fd.append('files',f)});try{var res=await api('/api/upload-multiple',{method:'POST',body:fd});e.target.value='';await openRepo(currentRepo.id);toast((res.warnings&&res.warnings.length)?'⚠️ Upload selesai, ada warning secret':'📤 Upload selesai')}catch(err){toast('❌ '+err.message)}}async function importUrl(){var u=prompt('Masukkan URL raw file:');if(!u)return;var name=prompt('Nama file/path opsional (contoh: src/app.js):','');await api('/api/import-from-url',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:u,fileName:name,repoId:currentRepo.id})});await openRepo(currentRepo.id);toast('🌐 Import selesai')}function openReleaseModal(){document.getElementById('releaseVersion').value='v1.0.0';document.getElementById('releaseTitle').value='';document.getElementById('releaseNotes').value='';document.getElementById('releaseFileIds').value=(currentRepo.files||[]).map(function(f){return f.id}).slice(0,3).join(',');showModal('releaseModal')}async function saveRelease(){var body={version:document.getElementById('releaseVersion').value,title:document.getElementById('releaseTitle').value,notes:document.getElementById('releaseNotes').value,fileIds:document.getElementById('releaseFileIds').value};await api('/api/repos/'+currentRepo.id+'/releases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});closeModal('releaseModal');await openRepo(currentRepo.id);toast('🚀 Release dibuat')}async function deleteRelease(id){if(!confirm('Hapus release?'))return;await api('/api/repos/'+currentRepo.id+'/releases/'+id,{method:'DELETE'});await openRepo(currentRepo.id);toast('🗑️ Release dihapus')}function openShareModal(){document.getElementById('shareType').value='repo';document.getElementById('shareTarget').value='';document.getElementById('sharePass').value='';document.getElementById('shareHours').value='24';document.getElementById('shareMax').value='0';showModal('shareModal')}async function saveShare(){var body={type:document.getElementById('shareType').value,targetId:document.getElementById('shareTarget').value,password:document.getElementById('sharePass').value,expiresHours:document.getElementById('shareHours').value,maxDownloads:document.getElementById('shareMax').value};var s=await api('/api/repos/'+currentRepo.id+'/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});closeModal('shareModal');await openRepo(currentRepo.id);copyUrl(s.absoluteShareUrl);toast('🔗 Share link dibuat dan disalin')}async function deleteShare(id){await api('/api/repos/'+currentRepo.id+'/shares/'+id,{method:'DELETE'});await openRepo(currentRepo.id);toast('🗑️ Share dihapus')}async function openTrashFiles(){var data=await api('/api/repos/'+currentRepo.id+'/trash');document.getElementById('trashBox').innerHTML=(data.files||[]).length?(data.files||[]).map(function(f){return '<div class="file-row"><div class="file-main"><span>🗑️</span><b>'+esc(f.name)+'</b><small>'+esc(f.deletedAt||'')+'</small></div><div class="file-actions"><button onclick="restoreFile(\''+f.id+'\')">♻️ Restore</button><button class="danger" onclick="purgeFile(\''+f.id+'\')">❌ Permanent</button></div></div>'}).join(''):'<div class="empty">Trash file kosong.</div>';showModal('trashModal')}async function restoreFile(id){await api('/api/repos/'+currentRepo.id+'/trash/'+id+'/restore',{method:'POST'});closeModal('trashModal');await openRepo(currentRepo.id);toast('♻️ File direstore')}async function purgeFile(id){if(!confirm('Hapus permanen?'))return;await api('/api/repos/'+currentRepo.id+'/trash/'+id,{method:'DELETE'});openTrashFiles();toast('❌ File dihapus permanen')}async function openTrashRepos(){var data=await api('/api/trash');document.getElementById('trashBox').innerHTML=(data.repos||[]).length?(data.repos||[]).map(function(r){return '<div class="file-row"><div class="file-main"><span>🗑️</span><b>'+esc(r.name)+'</b><small>'+esc(r.deletedAt||'')+'</small></div><div class="file-actions"><button onclick="restoreRepo(\''+r.repoId+'\')">♻️ Restore</button><button class="danger" onclick="purgeRepo(\''+r.repoId+'\')">❌ Permanent</button></div></div>'}).join(''):'<div class="empty">Trash repo kosong.</div>';showModal('trashModal')}async function restoreRepo(id){await api('/api/trash/repos/'+id+'/restore',{method:'POST'});closeModal('trashModal');loadRepos();toast('♻️ Repo direstore')}async function purgeRepo(id){if(!confirm('Hapus repo permanen?'))return;await api('/api/trash/repos/'+id,{method:'DELETE'});openTrashRepos();toast('❌ Repo dihapus permanen')}async function showHistory(id){var data=await api('/api/files/'+id+'/versions');document.getElementById('historyBox').innerHTML=(data.versions||[]).length?(data.versions||[]).map(function(v){return '<div class="file-row"><div class="file-main"><span>🕘</span><b>'+esc(v.name)+'</b><small>'+esc(v.created)+'</small></div><div class="file-actions"><button onclick="restoreVersion(\''+id+'\',\''+v.id+'\')">♻️ Restore</button></div></div>'}).join(''):'<div class="empty">Belum ada version history.</div>';showModal('historyModal')}async function restoreVersion(fileId,vid){await api('/api/files/'+fileId+'/versions/'+vid+'/restore',{method:'POST'});closeModal('historyModal');await openRepo(currentRepo.id);toast('♻️ Versi direstore')}async function globalSearch(){var q=prompt('Cari isi file apa?');if(!q)return;var data=await api('/api/search?repoId='+currentRepo.id+'&q='+encodeURIComponent(q));var files=(data[0]&&data[0].files)||[];document.getElementById('previewBox').innerHTML=files.length?files.map(function(f){return '<div class="file-row"><div class="file-main"><span>🔎</span><b>'+esc(f.name)+'</b><small>'+esc(f.preview||'match')+'</small></div><div class="file-actions"><button onclick="viewFile(\''+f.id+'\')">👁️ View</button></div></div>'}).join(''):'<div class="empty">Tidak ada hasil.</div>';document.getElementById('viewTitle').textContent='🔎 Search: '+q;showModal('viewModal')}function downloadZip(){var a=document.createElement('a');a.href='/download/'+currentRepo.id;a.download=currentRepo.name+'.zip';document.body.appendChild(a);a.click();a.remove()}function downloadFile(id,name){var a=document.createElement('a');a.href='/raw/'+id+'?download=1';a.download=name;document.body.appendChild(a);a.click();a.remove()}function copyInput(id){navigator.clipboard.writeText(document.getElementById(id).value).then(function(){toast('📋 Disalin')})}function copyUrl(u){navigator.clipboard.writeText(u).then(function(){toast('📋 Link disalin')})}function showModal(id){document.getElementById(id).style.display='block'}function closeModal(id){document.getElementById(id).style.display='none'}function installPWA(){if(deferredInstall){deferredInstall.prompt();deferredInstall=null}else toast('📱 Gunakan menu browser: Add to Home screen')}function renderMd(s){return esc(s).replace(/^# (.*)$/gim,'<h1>$1</h1>').replace(/^## (.*)$/gim,'<h2>$1</h2>').replace(/\*\*(.*?)\*\*/g,'<b>$1</b>').replace(/\n/g,'<br>')}async function logout(){await fetch('/api/auth/logout',{method:'POST'});location.href='/'}window.onclick=function(e){document.querySelectorAll('.modal').forEach(function(m){if(e.target===m)m.style.display='none'})};`;
  }

function sharedV4Css() {
    return `*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:radial-gradient(circle at 8% 4%,rgba(88,166,255,.22),transparent 30%),radial-gradient(circle at 90% 0%,rgba(163,113,247,.20),transparent 34%),radial-gradient(circle at 50% 110%,rgba(63,185,80,.12),transparent 34%),#050814;color:#f0f6fc;line-height:1.5;min-height:100vh}.wrap{width:min(1180px,100% - 28px);margin:auto}header{position:sticky;top:0;z-index:10;background:rgba(5,8,20,.72);backdrop-filter:blur(18px);border-bottom:1px solid rgba(139,148,158,.18)}.nav{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 0}.brand{font-weight:950;font-size:20px;letter-spacing:-.04em;text-decoration:none;color:#fff}.brand span{background:linear-gradient(90deg,#58a6ff,#a371f7,#f778ba);-webkit-background-clip:text;color:transparent}.nav-actions,.row-actions,.file-actions{display:flex;gap:10px;flex-wrap:wrap}.btn,button,.file-actions a{border:0;border-radius:14px;padding:10px 14px;background:linear-gradient(135deg,#238636,#2ea043);color:white;font-weight:800;text-decoration:none;cursor:pointer;font-size:14px;display:inline-flex;align-items:center;gap:7px}.btn.ghost,.ghost,.file-actions a, .file-actions button{background:rgba(88,166,255,.09);border:1px solid rgba(88,166,255,.20);color:#c9d1d9}.btn.danger{background:linear-gradient(135deg,#da3633,#f85149)}.hero,.repo-hero,.panel,.repo-card,.empty{background:linear-gradient(180deg,rgba(22,27,34,.88),rgba(13,17,23,.84));border:1px solid rgba(139,148,158,.20);border-radius:26px;box-shadow:0 24px 70px rgba(0,0,0,.30);padding:24px}.hero{display:grid;grid-template-columns:1fr auto;gap:20px;margin:26px 0}.hero h1,.repo-hero h1{font-size:clamp(30px,6vw,56px);line-height:1.02;margin:12px 0;letter-spacing:-.06em}.hero p,.repo-hero p{color:#8b949e;font-size:16px;margin:0}.hero-stat{min-width:170px;background:rgba(5,8,20,.54);border:1px solid rgba(139,148,158,.16);border-radius:22px;padding:18px;text-align:center}.hero-stat b{display:block;font-size:34px;color:#58a6ff}.hero-stat span{display:block;color:#8b949e;font-size:13px;margin-bottom:12px}.pill{display:inline-flex;border:1px solid rgba(88,166,255,.24);background:rgba(88,166,255,.10);color:#a5d6ff;border-radius:999px;padding:8px 12px;font-size:13px;font-weight:800}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:24px 0 14px}.toolbar h2{margin:0}.search,input,textarea,select{background:rgba(5,8,20,.70);border:1px solid rgba(139,148,158,.20);border-radius:16px;color:#f0f6fc;padding:12px 14px;outline:none}.search{min-width:min(420px,100%)}textarea{width:100%;min-height:280px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}.repo-card{display:block;text-decoration:none;color:inherit;position:relative;overflow:hidden;transition:.2s}.repo-card:hover{transform:translateY(-3px);border-color:rgba(88,166,255,.45)}.repo-card .card-icon{font-size:34px}.repo-card h3{color:#58a6ff;margin:8px 0;font-size:20px;word-break:break-word}.repo-card p{color:#8b949e;min-height:42px}.meta{display:flex;gap:10px;flex-wrap:wrap;color:#8b949e;font-size:13px}.meta.big{font-size:14px;margin-top:14px}.linkbox{display:flex;gap:10px;margin:12px 0}.linkbox input{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.file-list{display:flex;flex-direction:column;gap:10px}.file-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px;border:1px solid rgba(139,148,158,.18);border-radius:18px;background:rgba(22,27,34,.66)}.file-main{display:flex;align-items:center;gap:10px;min-width:0}.file-main b{word-break:break-all}.file-main small{color:#8b949e;border:1px solid rgba(139,148,158,.18);border-radius:999px;padding:4px 8px}.readme article{color:#c9d1d9}.readme h1,.readme h2,.readme h3{color:#fff}.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:100;padding:18px;overflow:auto}.modal-card{max-width:760px;margin:30px auto;background:linear-gradient(180deg,rgba(22,27,34,.96),rgba(13,17,23,.95));border:1px solid rgba(139,148,158,.22);border-radius:26px;padding:22px;box-shadow:0 24px 80px rgba(0,0,0,.45)}.modal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}.modal-head h2{margin:0}.close{background:rgba(248,81,73,.12);border:1px solid rgba(248,81,73,.28);color:#ffb4ad}.form-grid{display:grid;gap:14px}.label{font-size:13px;font-weight:800;color:#c9d1d9;margin-bottom:6px}.preview-frame{width:100%;height:70vh;border:1px solid rgba(139,148,158,.22);border-radius:18px;background:#fff}.preview-img{max-width:100%;border-radius:18px;border:1px solid rgba(139,148,158,.22)}pre{white-space:pre-wrap;word-break:break-word;background:#050814;border:1px solid rgba(139,148,158,.18);border-radius:18px;padding:16px;max-height:70vh;overflow:auto}.toast{position:fixed;right:18px;top:18px;z-index:200;background:#238636;color:#fff;border-radius:16px;padding:12px 16px;box-shadow:0 16px 40px rgba(0,0,0,.35);font-weight:800}body[data-theme=purple]{background:radial-gradient(circle at 12% 5%,rgba(216,180,254,.30),transparent 32%),radial-gradient(circle at 85% 10%,rgba(236,72,153,.22),transparent 34%),#14051f}body[data-theme=green]{background:radial-gradient(circle at 12% 5%,rgba(34,197,94,.25),transparent 32%),radial-gradient(circle at 85% 10%,rgba(16,185,129,.18),transparent 34%),#020807}body[data-theme=green] .brand span,body[data-theme=green] .repo-card h3{background:none;color:#7ee787}body[data-theme=purple] .brand span,body[data-theme=purple] .repo-card h3{background:linear-gradient(90deg,#d8b4fe,#f0abfc,#f9a8d4);-webkit-background-clip:text;color:transparent}.folder-row{border:1px solid rgba(88,166,255,.18);background:rgba(88,166,255,.07);border-radius:14px;padding:11px 14px;color:#a5d6ff}.warn,.warnbox{background:rgba(251,191,36,.13);border:1px solid rgba(251,191,36,.35);color:#fde68a;border-radius:12px;padding:6px 9px}.warnbox{margin-bottom:12px}.err{color:#ffb4ad}.file-actions .danger,button.danger{background:rgba(248,81,73,.14)!important;border:1px solid rgba(248,81,73,.28)!important;color:#ffb4ad!important}code{background:rgba(88,166,255,.10);padding:2px 6px;border-radius:8px} @media(max-width:760px){.hero{grid-template-columns:1fr}.toolbar,.file-row,.linkbox{flex-direction:column;align-items:stretch}.file-actions{width:100%}.file-actions a,.file-actions button{justify-content:center;flex:1}.nav{align-items:flex-start;flex-direction:column}.search{min-width:0;width:100%}}`;
  }

  function serveManifest(request) {
    const origin = new URL(request.url).origin;
    const manifest = { name: 'CodeHub V5.4 Final Pro', short_name: 'CodeHub', start_url: '/', scope: '/', display: 'standalone', background_color: '#050814', theme_color: '#0d1117', description: 'Final Pro R2 repository with releases, stats, share links, ZIP, Git clone, trash, history, preview and PWA.', icons: [{ src: `${origin}/icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }] };
    return jsonResponse(manifest, 200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
  }

  function serveServiceWorker(request) {
    const js = `const CACHE='codehub-v53-final-shell';self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['/', '/manifest.webmanifest', '/icon.svg'])));self.skipWaiting()});self.addEventListener('activate',e=>{e.waitUntil(self.clients.claim())});self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method==='GET' && u.origin===location.origin && !u.pathname.startsWith('/api/') && !u.pathname.startsWith('/raw/') && !u.pathname.startsWith('/download/')){e.respondWith(fetch(e.request).catch(()=>caches.match(e.request).then(r=>r||caches.match('/'))))}});`;
    return new Response(js, { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  function serveIconSvg() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#58a6ff"/><stop offset=".55" stop-color="#a371f7"/><stop offset="1" stop-color="#f778ba"/></linearGradient></defs><rect width="512" height="512" rx="120" fill="#050814"/><circle cx="130" cy="120" r="120" fill="#58a6ff" opacity=".18"/><circle cx="390" cy="95" r="120" fill="#a371f7" opacity=".16"/><path fill="url(#g)" d="M114 156c0-28 22-50 50-50h184c28 0 50 22 50 50v200c0 28-22 50-50 50H164c-28 0-50-22-50-50V156Zm70 42h144v36H184v-36Zm0 70h110v36H184v-36Zm0 70h150v36H184v-36Z"/></svg>`;
    return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } });
  }

  // Utility function
  function generateId() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
  }
  
  // Markdown renderer function
  function renderMarkdown(content) {
    // Simple markdown to HTML converter
    return content
      // Headers
      .replace(/^###### (.*$)/gim, '<h6>$1</h6>')
      .replace(/^##### (.*$)/gim, '<h5>$1</h5>')
      .replace(/^#### (.*$)/gim, '<h4>$1</h4>')
      .replace(/^### (.*$)/gim, '<h3>$1</h3>')
      .replace(/^## (.*$)/gim, '<h2>$1</h2>')
      .replace(/^# (.*$)/gim, '<h1>$1</h1>')
      
      // Bold & Italic
      .replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/gim, '<em>$1</em>')
      .replace(/_(.*?)_/gim, '<em>$1</em>')
      
      // Code
      .replace(/`(.*?)`/gim, '<code>$1</code>')
      
      // Blockquotes
      .replace(/^> (.*$)/gim, '<blockquote>$1</blockquote>')
      
      // Lists
      .replace(/^\s*[-*+] (.*$)/gim, '<li>$1</li>')
      .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
      
      // Links
      .replace(/\[([^\[]+)\]\(([^\)]+)\)/gim, '<a href="$2">$1</a>')
      
      // Line breaks
      .replace(/\n$/gim, '<br>')
      
      // Preserve multiple newlines
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>')
      
      // Wrap in paragraphs
      .replace(/^(?!<(\/)?(h|ul|ol|li|blockquote|code|pre)).*$/gim, '<p>$&</p>')
      
      // Clean up empty paragraphs
      .replace(/<p><\/p>/g, '')
      .replace(/<p><br><\/p>/g, '')
      
      // Handle code blocks
      .replace(/```([^`]+)```/g, '<pre><code>$1</code></pre>');
  }
  
  // HTML escape function
  function escapeHtml(unsafe) {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
