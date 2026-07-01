# CodeHub V5.5 — Binary Backup Fix

Versi ini memperbaiki kasus `file.zip` / file binary menjadi kosong saat klik Download file atau Download ZIP repo.

## Fix utama

- Binary tetap disimpan ke R2 object seperti sebelumnya.
- Binary kecil/menengah juga disimpan sebagai backup base64 di metadata repo.
- Raw/Download/ZIP/Git clone membaca bytes dengan urutan aman:
  1. R2 object asli
  2. backup base64 metadata
  3. legacy embedded content
- Kalau object lama hilang dan tidak ada backup, sistem tidak diam-diam membuat file kosong.
- Download file memakai `/raw/<fileId>?download=1` tetap dipertahankan.
- Download ZIP repo tetap binary-safe.
- Public URL cantik `/nama-repo` dan Git URL `/nama-repo.git` tetap aktif.

## Penting

File binary yang sudah terlanjur rusak/kosong sebelum versi ini tidak bisa dipulihkan otomatis kalau bytes aslinya memang sudah tidak ada di R2. Untuk file seperti itu, upload ulang file aslinya setelah deploy versi V5.5 ini.

Binding R2 tetap:

```txt
KODE_STORAGE
```

Login ENV tetap:

```txt
ADMIN_USER
ADMIN_PASS
```
