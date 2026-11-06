# MyLKPD (mod_mylkpd) — LKPD Interaktif untuk Moodle

Versi 1.1.0 (beta) · Moodle 4.1+

Plugin aktivitas Moodle (4.1+). Guru cukup mengunggah LKPD (PDF atau Word), siswa mengerjakan
langsung di atas halaman LKPD, lalu guru menilai dari Moodle. Nilai otomatis masuk Gradebook.

## Instalasi / update
1. Site administration > Plugins > Install plugins > unggah ZIP (atau ekstrak ke `moodle/mod/mylkpd`).
2. Site administration > Notifications untuk menjalankan instalasi/upgrade database.
3. Site administration > Development > Purge caches.

## Format file
| File | Cara tampil |
|---|---|
| PDF | Selalu bisa, ditampilkan dengan PDF.js. |
| DOCX | Jika situs punya pengonversi dokumen (unoconv/Google Drive): dikonversi ke PDF (tata letak paling akurat). Jika tidak: ditampilkan langsung di browser dengan docx-preview. |
| DOC, ODT | Butuh pengonversi dokumen. Tanpa itu, simpan ulang sebagai DOCX atau PDF. |

Mode tampilan (pdf/docx) dipilih saat LKPD pertama kali dibuka dan diingat per aktivitas,
supaya posisi jawaban siswa tidak bergeser. Mode direset hanya jika guru mengganti file.

## Cara mengerjakan (pengaturan aktivitas)
- **Anotasi**: siswa menulis/mencoret di atas halaman (PDF atau Word).
- **Edit teks** (khusus .docx): siswa mengetik langsung di paragraf dan sel tabel LKPD.
  Tombol Enter membuat baris baru di paragraf yang sama; tempel (paste) selalu sebagai teks biasa.
  Hanya paragraf yang diubah yang disimpan (dibersihkan dengan HTMLPurifier Moodle).

## Gambar dari siswa
Tombol **🖼 Gambar** (baris Sisipkan) untuk menambahkan foto/gambar ke LKPD, misalnya foto hasil praktikum.
- Gambar diperkecil di browser (sisi terpanjang maks. 1600 px) sebelum diunggah, lalu diletakkan
  di tengah halaman yang sedang dilihat.
- **Seret gambar** untuk memindahkan, **seret kotak di sudut kanan bawah** untuk mengubah ukuran
  (proporsi tetap). Bisa dihapus dengan Penghapus dan dibatalkan dengan Urungkan.
- Disimpan di file storage Moodle (area `answerimage`, per jawaban), bukan di database.
  Hanya pemilik jawaban, anggota kelompoknya, dan guru yang bisa membuka gambarnya.
- Server memeriksa isi file (JPG/PNG/GIF/WebP), ukuran maks. 5 MB, maks. 30 gambar per LKPD.
  Gambar yang sudah tidak dipakai dihapus saat LKPD dikumpulkan.
- Ikut tersinkron pada kerja kelompok dan tampil di halaman penilaian guru.

## Penilaian dengan rubrik
MyLKPD mendukung *Advanced grading* Moodle (rubrik dan panduan penilaian), sama seperti Assignment.
1. Di halaman **Jawaban siswa** klik **Atur rubrik** (atau Pengaturan aktivitas > Nilai >
   Metode penilaian: *Rubrik*).
2. Buat kriteria dan level beserta poinnya dengan editor rubrik Moodle, lalu simpan sebagai siap pakai.
3. Saat menilai, guru mengklik level di setiap kriteria. Nilai dihitung otomatis sesuai nilai maksimum
   aktivitas dan masuk ke Gradebook (untuk kerja kelompok: ke semua anggota).
4. Siswa melihat rubrik beserta level yang dipilih guru di kartu status LKPD.
Tanpa rubrik, guru tetap bisa mengisi nilai langsung.

## Edit setelah dikumpulkan
Pengaturan "Edit setelah dikumpulkan": *Ya, sampai dinilai guru* (bawaan), *Ya, kapan saja*, atau *Tidak*.
Jika diizinkan, siswa melihat tombol **Edit lagi** di bilah aksi bawah (tempat tombol Kumpulkan): LKPD kembali menjadi draf, lalu dikumpulkan ulang.
Pada kerja kelompok, Edit lagi membuka LKPD untuk seluruh kelompok. Guru selalu bisa membuka kembali
lewat halaman penilaian.

## Kerja kelompok (kolaborasi)
- Centang **Kerja kelompok** di pengaturan aktivitas. Memakai grup kursus; pilih grouping di
  "Pengaturan umum modul" untuk membatasi grup. Siswa tanpa grup tidak bisa mengerjakan.
- Satu LKPD per kelompok. Tersimpan otomatis (AJAX) dan disinkronkan tiap 3 detik.
- Daftar anggota online tampil di atas LKPD. Paragraf yang sedang diketik teman dikunci
  sementara dengan label "<nama> sedang mengetik", jadi tidak saling menimpa.
- Urungkan (Undo) hanya membatalkan perubahan milik sendiri.
- Satu anggota menekan "Kumpulkan", LKPD terkunci untuk seluruh kelompok.
- Bilah bawah: status penyimpanan ("Tersimpan pukul 10:32", atau pesan gagal beserta alasannya),
  tombol **Simpan sekarang** dan **Kumpulkan LKPD**.
- **Nama penulis** tampil sebagai label berwarna di setiap jawaban dan paragraf yang diedit
  (bisa disembunyikan dengan "Tampilkan nama penulis"). Juga tampil di halaman penilaian guru.
- Guru menilai per kelompok (nilai masuk ke semua anggota) dan melihat tabel **Kontribusi**
  (siapa terakhir mengubah paragraf/jawaban). Di mode baca, paragraf yang diubah diberi
  warna sesuai anggota, dengan keterangan "Terakhir diubah oleh ...".
- "Cara mengerjakan" dan "Kerja kelompok" terkunci setelah ada siswa yang mulai mengerjakan.

## Toolbar (referensi CKEditor)
Satu panel yang menempel di atas saat halaman digulir (menyesuaikan tema Boost/Classic).
Baris 1 (alat): **Ketik** (khusus DOCX), Pindah, Teks, Centang, Silang, Lingkari, Stabilo, Garis, Pensil,
Penghapus | Urungkan/Ulangi.
Baris 2: format teks paragraf (khusus DOCX): Tebal, Miring, Garis bawah, Coret, Pangkat, Indeks,
Warna teks, Stabilo teks, Hapus format | 5 warna, 3 ketebalan | Sisipkan: **Persamaan** (LaTeX dengan palet template dan
pratinjau, dirender KaTeX), **Simbol** (±, ×, √, π, °, panah, huruf Yunani, dll.), **Arab** (keyboard
huruf hijaiyah + harakat + angka Arab), **Tautan**.

- File DOCX: alat Ketik dan alat gambar tersedia bersamaan (gambar/coretan di atas halaman Word).
- File PDF: alat gambar + Persamaan/Tautan diletakkan di halaman; Simbol/Arab masuk ke kotak teks.
- Persamaan di paragraf disimpan sebagai teks `\(LaTeX\)` (aman dari HTMLPurifier); klik untuk mengedit.
- Kotak teks memakai `dir="auto"`, jadi jawaban berbahasa Arab otomatis rata kanan.
Posisi gambar disimpan dalam persen halaman, jadi tetap pas di HP maupun laptop.

## Struktur
- version.php, lib.php, locallib.php, mod_form.php
- view.php (siswa), ajax.php (autosave/sinkron), upload.php (unggah gambar), submissions.php (daftar), grade.php (penilaian), index.php
- db/install.xml, db/upgrade.php, db/access.php
- classes/event, classes/form, classes/privacy
- js/worksheet.js (editor), styles.css
- js/pdfjs (PDF.js 3.11.174), js/docx (docx-preview 0.4.1 + JSZip 3.10.1), js/katex (KaTeX 0.16.29) — lihat thirdpartylibs.xml
- lang/en, lang/id

## Belum ada
Backup/restore kursus, kunci jawaban otomatis, coretan koreksi dari guru, riwayat versi.
Sinkronisasi memakai polling (bukan WebSocket): cocok untuk kelompok kecil (2–8 siswa).
