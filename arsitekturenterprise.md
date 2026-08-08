# Enterprise Architecture: Menangani High Traffic & Bottleneck

Masalah yang kamu hadapi (Database Connection Timeout karena banyak request ke satu fitur secara bersamaan) adalah masalah klasik yang dialami oleh hampir semua website besar saat mulai berkembang (seperti Gojek, Tokopedia, Netflix, dll). 

Ketika fitur `get_netflix_token_link` dipanggil, kemungkinan besar API kamu melakukan proses yang berat (mungkin berkomunikasi dengan bot, menunggu balasan, dan mengunci koneksi database selama proses itu berlangsung). Jika ada 100 orang melakukan ini bersamaan, semua koneksi database akan habis dipakai untuk menunggu.

Berikut adalah bagaimana perusahaan besar mendesain arsitektur mereka (Enterprise Architecture) untuk menyelesaikan masalah ini, yaitu dengan membuat **"Jalur Khusus" (Asynchronous Processing & Message Queueing)**.

---

## 1. Konsep Utama: Synchronous vs Asynchronous

### ❌ Cara Lama (Synchronous - Yang bikin Timeout)
1. User klik "Get Token Netflix".
2. Request masuk ke API.
3. API membuka koneksi Database.
4. API menyuruh Bot memproses token.
5. **API MENUNGGU** bot selesai (bisa bermenit-menit). Koneksi database tetap ditahan!
6. Ratusan user lain datang -> Koneksi Database Habis -> **CRASH**.

### ✅ Cara Enterprise (Asynchronous dengan Queue)
1. User klik "Get Token Netflix".
2. Request masuk ke API.
3. API menyimpan request tersebut ke dalam **Antrean (Message Queue)** seperti Redis/RabbitMQ, dan langsung membalas ke User: *"Permintaan sedang diproses, mohon tunggu..."*.
4. Koneksi API dan Database langsung **ditutup dan bebas** melayani user lain.
5. Di belakang layar, ada aplikasi terpisah (**Worker**) yang mengambil tugas dari antrean satu per satu dan menyelesaikannya.
6. Setelah Worker selesai, hasilnya dikirim kembali ke user (bisa lewat WebSocket atau user yang melakukan *pull/refresh*).

---

## 2. Komponen Arsitektur Enterprise (Yang Harus Disiapkan)

Untuk membuat sistem yang tahan banting (Resilient), kita memecah beban kerja (Microservices/Worker pattern):

### A. Message Broker / Queue (Si Pengatur Antrean)
Kamu butuh sistem antrean. Di ekosistem Node.js/NestJS, standar industrinya adalah menggunakan **Redis** dengan library **BullMQ** (atau menggunakan RabbitMQ/Kafka untuk skala raksasa).
- **Fungsi:** Menampung ribuan request dalam hitungan milidetik tanpa membebani PostgreSQL. Jika ada 10,000 request masuk, semuanya ditampung dulu di Redis.

### B. Dedicated Worker Nodes (Si Pekerja Keras)
Jangan campurkan proses berat (seperti scraping/bot Netflix) ke dalam API utama (`volve-api`).
- Buat service terpisah (sepertinya kamu sudah punya `apps/bot` atau `apps/bot2`).
- Tugaskan service ini khusus hanya untuk *mendengarkan* antrean dari Redis. 
- Kamu bisa membatasi: *"Worker ini cuma boleh jalanin maksimal 5 token Netflix bersamaan (Concurrency Limit)"*. Walaupun ada 10,000 antrean, sistem tidak akan crash karena dia mengerjakannya dengan kecepatan yang stabil.

### C. Database Connection Pooler (PgBouncer)
Jika PostgreSQL kamu langsung ditembak oleh API dan Worker, koneksinya bisa cepat habis.
- Perusahaan besar menggunakan **PgBouncer**. Ini adalah penengah antara Aplikasi dan PostgreSQL.
- PgBouncer bisa menampung 10,000 request koneksi, tapi dia hanya meneruskannya menjadi 50 koneksi sungguhan ke PostgreSQL secara bergantian. Ini menyelamatkan database dari crash/timeout.

### D. Rate Limiting & Throttling
Website besar tidak membiarkan 1 user melakukan spamming. 
- Di tingkat API Gateway atau Nginx, pasang Rate Limiting (misal: 1 IP cuma boleh request token 1 kali setiap 5 menit).

---

## 3. Implementasi di Project Kamu (Volve Capital)

Melihat struktur repositori kamu (`apps/api` dan `apps/bot2`), kamu sudah berada di jalur yang benar. Berikut saran cara mengimplementasikannya:

1. **Gunakan Redis + BullMQ di API (NestJS):**
   - Saat request `get_netflix_token_link` datang, jangan langsung panggil fungsi Bot.
   - Masukkan data request (email, user id) ke antrean (Queue) bernama `netflix-token-queue`.
   - Return response HTTP 202 (Accepted) ke frontend/user: `{ status: "processing", message: "Token sedang digenerate, mohon tunggu..." }`.

2. **Proses di Bot (Worker):**
   - `apps/bot2` bertugas membaca (consume) `netflix-token-queue` dari Redis.
   - Atur concurrency-nya (misalnya `concurrency: 5`), artinya bot hanya akan memproses maksimal 5 token bersamaan, sisanya antre dengan tertib.
   - Setelah bot berhasil mendapatkan link, bot akan melakukan update ke Database (bahwa token sudah siap) ATAU mengirim notifikasi langsung ke frontend via **WebSockets (Socket.io)** yang sepertinya sudah kamu miliki di `SocketGateway`.

3. **Frontend Handling:**
   - Frontend menampilkan *loading spinner*.
   - Frontend mendengarkan event WebSocket dari server, atau melakukan *polling* (bertanya ke server setiap 3 detik) apakah token-nya sudah siap.

### Keuntungan Skema Ini:
- **Zero Crash:** Sebanyak apapun request (misal traffic tiba-tiba naik 1000x lipat), API tidak akan crash. Antrean di Redis hanya akan bertambah panjang, dan user hanya perlu menunggu sedikit lebih lama.
- **Scalable:** Kalau antrean terlalu panjang (lambat), kamu tinggal menghidupkan PM2 bot lebih banyak lagi (`pm2 scale bot2 +3`).

---

## Kesimpulan
Penyebab utama API kamu crash adalah karena proses generasinya bersifat **Synchronous (menunggu)** dan mengunci database. Dengan mengubah jalur Netflix Token ini menjadi **Asynchronous (menggunakan Message Queue / Redis)**, beban API utama akan turun drastis dan website kamu akan menjadi setangguh website enterprise profesional.
