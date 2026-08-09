# Arsitektur Baru Penyimpanan Session & Optimasi Token Retrieval

Dokumen ini merangkum arsitektur baru dan berbagai perbaikan sistem yang telah diterapkan pada aplikasi **Volve Capital** untuk mengoptimalkan pengambilan Netflix Token secara instan, serta menstabilkan antrean perintah (task queue) pada Bot.

---

## 1. Arsitektur Direct Database Session Sync

Sebelumnya, setiap kali sistem membutuhkan Netflix Token, API harus mengirimkan tugas (task) ke antrean database, mempolling statusnya, lalu Bot akan membaca file JSON secara lokal dari Google Drive untuk melakukan request token. Alur ini lambat (30+ detik) dan rentan mengalami timeout.

### Alur Kerja Baru:

* **Database Session Table per Tenant**:
  * Dibuat tabel baru bernama `account_session` di setiap schema tenant (`paytronik`, `rojolapak`, `capital`, dll) menggunakan Sequelize Model `AccountSession`.
  * Tabel ini menyimpan JSON `session_data` (cookies) yang diasosiasikan dengan `platform` (netflix) dan `identifier` (email akun yang disanitasi).
* **Fast-path Direct Fetch (NestJS API)**:
  * Saat user mengklik **Ambil Token**, API pertama-tama akan mencari data session cookies di tabel `account_session` tenant terkait.
  * Jika cookies ditemukan, API NestJS secara asinkron akan langsung melakukan request HTTP `fetch` ke Netflix FTL API menggunakan resource internal server.
  * Langkah ini berhasil memotong waktu pemrosesan dari **30 detik menjadi kurang dari 1 detik (hitungan milidetik)** tanpa melibatkan interaksi browser bot.
* **Auto-Fallback**:
  * Jika cookies tidak ditemukan di database, atau jika request langsung ke Netflix gagal (misal karena session kedaluwarsa), API secara otomatis melakukan fallback dengan mendaftarkan tugas ke task queue agar Bot login ulang di background.

---

## 2. Mekanisme Sinkronisasi & Proteksi Duplikasi Cookies

Untuk memastikan database selalu terisi dengan data session terbaru dari Google Drive tanpa membebani server, kami menerapkan beberapa optimasi pada Bot (`apps/bot2`):

1. **Auto-Sync saat Bot Startup**:
   * Ketika Bot pertama kali terhubung ke server Socket.IO, Bot secara otomatis memindai direktori Google Drive lokal (`session_data`).
   * Bot mengelompokkan (chunking) file cookies yang ditemukan menjadi **batch berisi 100 akun** untuk dikirim secara asinkron dengan jeda waktu 300ms guna mencegah beban lonjakan jaringan.
   * Di sisi API, penyimpanan dilakukan menggunakan query tunggal `bulkCreate` dengan opsi `ON CONFLICT DO UPDATE` (`conflictAttributes: ['platform', 'identifier']`), sehingga ratusan data session tersimpan dalam hitungan 1-2 detik tanpa memblokir Node.js event loop.
2. **Restriksi Hanya Modul Netflix**:
   * Karena kebutuhan direct fetch token hanya ditujukan untuk Netflix, kami membatasi pengiriman Socket sync hanya untuk modul Netflix (`this.instanceId === 'netflix'`).
   * Modul lain seperti **Duoke**, Shopee, dan WhatsApp tetap menyimpan session secara lokal di disk, namun **tidak akan pernah dikirim ke database**, sehingga log database Anda bersih dari aktivitas spam modul lain.
3. **Penyaringan Cookies Secara Ketat (Strict Hash Check)**:
   * Bot memiliki cache internal `lastSavedSessionHash` untuk membandingkan cookies terbaru dengan versi penyimpanan terakhir.
   * Proses pembandingan hanya mencocokkan **`name` dan `value` cookies**, serta mengabaikan properti dinamis yang sering bergeser (seperti kolom `expires` / tanggal kadaluarsa cookies, data `localStorage` di `origins`, dsb).
   * Hal ini menjamin Bot hanya mengirim data baru ke API jika dan hanya jika status login user benar-benar berubah.

---

## 3. Optimasi Latency Antrean Task (ZSET Bypass)

Ketika Bot terpaksa harus digunakan (seperti untuk Reset Password, Auto Reload, Auto Upgrade, atau Login TV secara manual):

* **Masalah Lama**: Perintah manual dikirim ke antrean `QUEUED` di database dan dijadwalkan lewat Redis ZSET. Karena ZSET bergantung pada kecocokan waktu jam internal server (clock sync), sering terjadi delay sekitar 2 menit sebelum task akhirnya di-dispatch ke Bot.
* **Solusi Baru**: Dibuat method `enqueueImmediate` pada `TaskQueueService`. Ketika user melakukan trigger manual dari dashboard:
  1. API langsung menandai status task sebagai `DISPATCHED` di database.
  2. API langsung melempar data tugas ke **Redis Stream** secara instan.
  3. Bot menerima perintah dan menjalankannya **detik itu juga** tanpa menunggu scheduler ZSET.

---

## 4. Bypass SNAP QRIS Payment

* **Masalah Lama**: Pada alur pembuatan pembayaran (`CreatePayment` di `public.service.ts`), API mencoba memanggil DOKU SNAP QRIS API terlebih dahulu. Jika gagal (sering terjadi error 500 Internal Server Error dari sisi Doku), API baru beralih menggunakan pembayaran normal link Doku Checkout. Proses ini memicu log error/warning yang mengotori sistem.
* **Solusi Baru**: Panggilan ke DOKU SNAP QRIS dinonaktifkan sepenuhnya. API langsung mengembalikan string QRIS kosong (`qrisString = ''`) dan segera memberikan tautan pembayaran normal DOKU Checkout (`payment_url`) secara instan. Proses checkout menjadi lebih cepat, bersih, dan bebas dari trigger error.
