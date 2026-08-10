# Rencana Implementasi Fitur Riwayat Pembelian

Dokumen ini berisi rencana perubahan pada backend (API) dan frontend (Next.js) untuk menambahkan fitur **Riwayat Pembelian**. Fitur ini memungkinkan pengguna mencari daftar voucher yang pernah mereka beli menggunakan Email atau Nomor WhatsApp, serta melihat detail akun & instruksi penggunaannya kembali.

---

## Alur Kerja Fitur

1. **Menu Baru di Navbar**: Pengguna mengklik menu "RIWAYAT" di navbar utama.
2. **Halaman Pencarian**: Pengguna diarahkan ke `/history`, di mana terdapat form input untuk memasukkan Email atau Nomor WhatsApp.
3. **Pencarian Riwayat**: Sistem memanggil API backend untuk mencocokkan input dengan kolom `buyer_email` atau `buyer_whatsapp` pada tabel `voucher`.
4. **Normalisasi Input**: Backend secara otomatis menormalisasi format nomor telepon (misal: jika diinput `0812...` akan dicari juga format `62812...` dan sebaliknya).
5. **Daftar Hasil**: Menampilkan list transaksi/voucher yang ditemukan (status pembayaran sukses/Paid).
6. **Detail Akun**: Saat salah satu item diklik, detail akun (Email, Password, Profil, Masa Aktif, Panduan Netflix, dsb.) akan ditampilkan di modal atau accordion detail, mirip dengan halaman redeem.

---

## 1. Perubahan Backend (NestJS API)

Kita akan menambahkan endpoint publik baru: `GET /public/purchases` yang dapat diakses tanpa autentikasi (karena bersifat public-route untuk konsumen).

### a. Modifikasi [public.controller.ts](file:///e:/latihan%20coding/1volvecapital/volvecapital/apps/api/src/modules/public/public.controller.ts)
Menambahkan route baru di dalam `PublicController`:

```typescript
  @Get('purchases')
  async getPurchases(
    @Headers() headers: any,
    @Query('identifier') identifier: string,
  ) {
    if (!identifier) {
      throw new BadRequestException('Email atau nomor WhatsApp wajib diisi');
    }
    const host = headers.host || '';
    const xTenantId = headers['x-tenant-id'];
    const xForwardedHost = headers['x-forwarded-host'];
    const tenantId = await this.getTenantId(host, xTenantId, xForwardedHost);
    
    return this.publicService.getPurchasesByIdentifier(tenantId, identifier);
  }
```

### b. Modifikasi [public.service.ts](file:///e:/latihan%20coding/1volvecapital/volvecapital/apps/api/src/modules/public/public.service.ts)
Menambahkan logika pencarian voucher di `PublicService`:

```typescript
  async getPurchasesByIdentifier(tenantId: string, identifier: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      // Normalisasi WhatsApp/No HP
      let cleanIdentifier = identifier.trim();
      const searchConditions: any[] = [
        { buyer_email: cleanIdentifier }
      ];

      // Jika input hanya angka, deteksi sebagai nomor HP dan tambahkan variasi prefix
      if (/^\+?\d+$/.test(cleanIdentifier)) {
        const digits = cleanIdentifier.replace(/\D/g, '');
        searchConditions.push({ buyer_whatsapp: digits });
        
        if (digits.startsWith('0')) {
          searchConditions.push({ buyer_whatsapp: '62' + digits.substring(1) });
        } else if (digits.startsWith('62')) {
          searchConditions.push({ buyer_whatsapp: '0' + digits.substring(2) });
        }
      } else {
        searchConditions.push({ buyer_whatsapp: cleanIdentifier });
      }

      // Ambil daftar voucher yang lunas (PAID) atau sudah digunakan (USED)
      const vouchers = await this.voucherRepository.findAll({
        where: {
          [Op.or]: searchConditions,
          payment_status: 'PAID'
        },
        include: [
          {
            model: ProductVariant,
            as: 'product_variant',
            include: [
              { model: Product, as: 'product' },
              { model: Tutorial, as: 'tutorial' }
            ],
          },
          {
            model: TransactionItem,
            as: 'transaction_item',
            include: [
              {
                model: AccountUser,
                as: 'user',
                include: [
                  {
                    model: Account,
                    as: 'account',
                    include: [{ model: Email, as: 'email' }],
                  },
                  {
                    model: AccountProfile,
                    as: 'profile',
                  },
                ],
              },
            ],
          },
        ],
        order: [['created_at', 'DESC']],
        transaction,
      });

      // Format response agar Frontend mudah mengonsumsi data akun langsung
      const results = vouchers.map(v => {
        const user = (v.transaction_item as any)?.user;
        const accountData = user ? {
          email: user.account?.email?.email,
          password: user.account?.account_password,
          profile_name: user.profile?.name,
          expired_at: user.expired_at,
          metadata: (() => {
            try {
              return user.profile?.metadata ? JSON.parse(user.profile.metadata) : {};
            } catch (e) {
              return {};
            }
          })(),
        } : null;

        return {
          id: v.id,
          status: v.status,
          payment_status: v.payment_status,
          buyer_name: v.buyer_name,
          buyer_email: v.buyer_email,
          buyer_whatsapp: v.buyer_whatsapp,
          created_at: v.created_at,
          expired_at: v.expired_at,
          access_token: v.access_token,
          product_variant: v.product_variant,
          account: accountData
        };
      });

      await transaction.commit();
      return results;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
```

---

## 2. Perubahan Frontend (Next.js Landingpage)

### a. Modifikasi Navbar [navbar.tsx](file:///e:/latihan%20coding/1volvecapital/volvecapital/apps/landingpage/src/components/navbar.tsx)
Menambahkan menu "RIWAYAT" pada array `navLinks`:

```typescript
  const navLinks = [
    { name: 'HOME', href: '/', icon: Home },
    { name: 'PRODUK', href: '/product', icon: Package },
    { name: 'TUTORIAL', href: '/tutorial', icon: BookOpen },
    { name: 'BLOG', href: '/blog', icon: FileText },
    { name: 'REDEEM', href: '/redeem', icon: Key },
    { name: 'RIWAYAT', href: '/history', icon: Clock }, // Tambahan menu riwayat
  ]
```

### b. Membuat Halaman Baru: `/history`
Membuat file baru [page.tsx](file:///e:/latihan%20coding/1volvecapital/volvecapital/apps/landingpage/src/app/history/page.tsx). Halaman ini akan memuat:
1. Input form untuk email/nomor HP.
2. Logika pemanggilan API `GET /public/purchases?identifier=...`.
3. Tampilan hasil pencarian dalam bentuk list yang rapi.
4. Detail panel interaktif saat item riwayat diklik (menggunakan UI yang mirip dengan halaman `/redeem`, lengkap dengan panduan Netflix/tutorial/salin data akun).

---

## Rencana Verifikasi

### Pengujian Manual
1. Buka landing page, periksa apakah menu **RIWAYAT** muncul di Navbar.
2. Klik menu tersebut untuk memastikan rute mengarah ke `/history`.
3. Lakukan pengujian pencarian dengan:
   - Email pembeli yang valid (misal: `test@example.com`).
   - Nomor WhatsApp dengan format berbeda (misal: dimulai dengan `08...` dan `628...`).
4. Pastikan data voucher beserta detail akunnya muncul dan dapat diklik untuk melihat detail kredensialnya.
