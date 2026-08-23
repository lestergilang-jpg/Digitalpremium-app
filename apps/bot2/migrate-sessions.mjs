import { io } from 'socket.io-client';
import fs from 'fs';
import path from 'path';

// --- CONFIGURATION ---
const API_URL = 'http://localhost:4000'; // Pastikan API sedang berjalan
const EMAIL = 'paytronikpremium@gmail.com'; // Email admin/bot
const PASSWORD = '@Aezakmi123'; // Password admin/bot
const CLOUD_DATA_DIR = 'G:\\My Drive\\VolveBotData'; // Folder GDrive
// ---------------------

async function migrate() {
  console.log('Logging in to API...');
  const res = await fetch(`${API_URL}/tenant/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD })
  });

  if (!res.ok) {
    throw new Error(`Failed to login to API: ${res.statusText}`);
  }

  const { id: tenantId, token } = await res.json();
  console.log(`Successfully logged in. Tenant ID: ${tenantId}`);

  console.log(`Connecting to WebSocket server...`);
  const socket = io(API_URL, {
    auth: { token: token }, // Pass raw token here just in case, socket gateway handles VC prefix automatically or we can set it via extraHeaders
    extraHeaders: { 
      'x-tenant-id': tenantId,
      'Authorization': `VC ${token}`
    },
    transports: ['websocket']
  });

  socket.on('connect', async () => {
    console.log('Socket connected! Checking session_data folder...');
    
    const sessionDir = path.join(CLOUD_DATA_DIR, 'session_data');
    if (!fs.existsSync(sessionDir)) {
      console.log(`ERROR: Folder tidak ditemukan di ${sessionDir}`);
      process.exit(1);
    }

    const files = fs.readdirSync(sessionDir);
    // Ignore directories and only take JSON files
    const jsonFiles = files.filter(f => f.endsWith('.json') && fs.statSync(path.join(sessionDir, f)).isFile());
    
    console.log(`Ditemukan ${jsonFiles.length} file session.`);

    const batchSize = 100;
    let currentBatch = [];
    let totalMigrated = 0;

    for (const file of jsonFiles) {
      // Filename format: instanceId_contextName.json or instanceId.json
      let platform = '';
      let identifier = '';
      
      const basename = file.replace(/\.json$/, '');
      const parts = basename.split('_');
      
      if (parts.length > 1) {
          platform = parts[0];
          identifier = parts.slice(1).join('_');
      } else {
          platform = basename;
          identifier = 'default';
      }

      if (platform.startsWith('netflix')) {
          platform = 'netflix';
      }

      const filePath = path.join(sessionDir, file);
      
      try {
        const sessionData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (sessionData && sessionData.cookies) {
          currentBatch.push({ platform, identifier, sessionData });
          totalMigrated++;
        }

        if (currentBatch.length >= batchSize) {
          socket.emit('save-account-sessions-batch', { sessions: currentBatch });
          console.log(`Mengirim batch... (Total diproses: ${totalMigrated})`);
          currentBatch = [];
          // Jeda sebentar agar tidak membebani database / socket
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (e) {
        console.error(`Gagal membaca file ${file}:`, e.message);
      }
    }

    if (currentBatch.length > 0) {
      socket.emit('save-account-sessions-batch', { sessions: currentBatch });
      console.log(`Mengirim sisa batch... Total yang akan dimigrasi: ${totalMigrated}`);
    }

    console.log('----------------------------------------------------');
    console.log(`Selesai membaca semua file. Menunggu 3 detik agar socket selesai mengirim...`);
    
    setTimeout(() => {
        console.log('Migrasi berhasil. Skrip ini akan ditutup.');
        process.exit(0);
    }, 3000);
  });

  socket.on('connect_error', (err) => {
    console.error('Socket connection error:', err.message);
    process.exit(1);
  });
}

migrate().catch(err => {
    console.error("Migration error:", err);
});
