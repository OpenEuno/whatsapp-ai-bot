const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const { Configuration, OpenAIApi } = require("openai");

// 🔹 Konfigurasi OpenAI
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY || "your_openai_api_key_here",
});
const openai = new OpenAIApi(configuration);

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "ai-coaching-bot"
  }),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

// 🔹 Inisialisasi users
let users = [];
const USERS_FILE = "users.json";
const SESSION_BACKUP_DIR = "session_backup";
const EXPIRY_NOTIFICATION_DAYS = [7, 3, 1];

// 🔹 Session Management
function backupSession() {
  try {
    if (!fs.existsSync(SESSION_BACKUP_DIR)) {
      fs.mkdirSync(SESSION_BACKUP_DIR);
    }
    
    const sessionSource = './.wwebjs_auth';
    if (fs.existsSync(sessionSource)) {
      const backupFile = `${SESSION_BACKUP_DIR}/session_backup_${Date.now()}.json`;
      const sessionData = fs.readFileSync(`${sessionSource}/session.json`);
      fs.writeFileSync(backupFile, sessionData);
      console.log('✅ Session backed up successfully');
    }
  } catch (error) {
    console.error('❌ Error backing up session:', error);
  }
}

// 🔹 Load & Save Users dengan error handling
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      users = JSON.parse(data);
      console.log(`✅ Loaded ${users.length} users from storage`);
    }
  } catch (error) {
    console.error('❌ Error loading users:', error);
    users = [];
  }
}

function saveUsers() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (error) {
    console.error('❌ Error saving users:', error);
  }
}

function findUser(number) {
  return users.find(u => u.number === number);
}

// 🔹 OpenAI Integration
async function generateAIResponse(userMessage, userData) {
  try {
    const systemPrompt = `Anda adalah AI coach profesional yang membantu pengguna dengan masalah sehari-hari. 
Berikan respon yang empatik, suportif, dan memberikan solusi praktis. 
Gunakan bahasa Indonesia yang santun dan mudah dimengerti.`;

    const completion = await openai.createChatCompletion({
      model: process.env.OPENAI_MODEL || "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      max_tokens: 500,
      temperature: 0.7,
    });
    
    return completion.data.choices[0].message.content;
  } catch (error) {
    console.error('❌ Error generating AI response:', error);
    
    // Fallback responses
    const fallbackResponses = [
      "Maaf, saya sedang mengalami gangguan teknis. Bisakah Anda mengulangi pertanyaannya?",
      "Sistem saya sedang sibuk. Silakan coba lagi dalam beberapa saat.",
      "Saya sedang tidak bisa mengakses pengetahuan saya. Mohon coba sebentar lagi."
    ];
    
    return fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];
  }
}

// 🔹 Expiry check dengan notifikasi
function checkExpired(user) {
  if (user.status === "paid" && user.expireAt && Date.now() > user.expireAt) {
    const previousStatus = user.status;
    user.status = "expired";
    user.expiryNotified = true;
    saveUsers();
    
    if (previousStatus === "paid") {
      try {
        client.sendMessage(user.number, 
          "⛔ Masa aktif Anda telah habis. Hubungi owner untuk perpanjangan layanan."
        );
      } catch (error) {
        console.error('❌ Gagal mengirim notifikasi expiry:', error);
      }
    }
    return true;
  }
  return false;
}

function checkAndNotifyExpiry(user) {
  if (user.status !== "paid" || !user.expireAt) return;

  const remainingDays = Math.ceil((user.expireAt - Date.now()) / (1000 * 60 * 60 * 24));
  
  if (EXPIRY_NOTIFICATION_DAYS.includes(remainingDays) && !user.expiryNotified) {
    try {
      client.sendMessage(user.number, 
        `🔔 Pemberitahuan: Masa aktif Anda akan berakhir dalam ${remainingDays} hari. Hubungi owner untuk perpanjangan.`
      );
      user.expiryNotified = true;
      saveUsers();
    } catch (error) {
      console.error('❌ Gagal mengirim notifikasi expiry:', error);
    }
  }
  
  if (remainingDays > Math.max(...EXPIRY_NOTIFICATION_DAYS) && user.expiryNotified) {
    user.expiryNotified = false;
    saveUsers();
  }
}

function getRemainingDays(user) {
  if (user.status === "paid" && user.expireAt) {
    const diff = user.expireAt - Date.now();
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  }
  return 0;
}

// 🔹 Command Handler
async function handleOwnerCommand(msg, command, args) {
  const from = msg.from;
  
  switch (command) {
    case 'add':
      if (args.length < 2) {
        return "❌ Format: /add [nomor] [hari] [kuota?]";
      }
      
      const target = args[0] + "@c.us";
      const days = parseInt(args[1]) || 30;
      const quota = args[2] ? parseInt(args[2]) : undefined;

      let user = findUser(target);
      if (!user) {
        user = { 
          number: target,
          registeredAt: Date.now(),
          usageCount: 0
        };
        users.push(user);
      }

      user.status = "paid";
      user.expireAt = Date.now() + days * 24 * 60 * 60 * 1000;
      user.expiryNotified = false;
      if (quota !== undefined) user.quota = quota;
      user.lastUpdated = Date.now();

      saveUsers();
      return `✅ User ${target} ditambahkan.\nMasa aktif: ${days} hari.\nQuota: ${quota ?? "Unlimited"}`;

    case 'cek':
      if (args.length < 1) {
        return "❌ Format: /cek [nomor]";
      }
      
      const targetUser = args[0] + "@c.us";
      const userData = findUser(targetUser);
      if (userData) {
        const days = getRemainingDays(userData);
        const status = userData.status === "paid" ? `Aktif (${days} hari tersisa)` : userData.status;
        return `📊 User ${targetUser}\nStatus: ${status}\nKuota: ${userData.quota ?? "Unlimited"}\nDigunakan: ${userData.usageCount || 0}x`;
      } else {
        return "❌ User tidak ditemukan.";
      }

    case 'list':
      const activeUsers = users.filter(u => u.status === "paid" && !checkExpired(u));
      const expiredUsers = users.filter(u => u.status === "expired");
      return `📋 Daftar User:\nAktif: ${activeUsers.length} user\nKadaluarsa: ${expiredUsers.length} user`;

    case 'help':
      return `🤖 Owner Commands:\n/add [nomor] [hari] [kuota] - Tambah user\n/cek [nomor] - Cek status user\n/list - List semua user\n/help - Tampilkan bantuan`;

    default:
      return "❌ Command tidak dikenali. Ketik /help untuk bantuan.";
  }
}

async function handleUserCommand(msg, command, args) {
  const from = msg.from;
  
  switch (command) {
    case 'start':
    case 'help':
      return "🤖 AI Coaching Bot\n\nKirim pesan untuk berbicara dengan AI coach!\n\nCommands:\n/status - Cek status akun\n/help - Tampilkan bantuan";

    case 'status':
      const user = findUser(from);
      if (!user) {
        return "❌ Anda belum terdaftar. Hubungi owner untuk akses.";
      }
      
      checkExpired(user);
      const days = getRemainingDays(user);
      
      if (user.status !== "paid") {
        return "⛔ Akses Anda tidak aktif. Hubungi owner untuk perpanjangan.";
      } else {
        return `✅ Status Akun:\nMasa aktif: ${days} hari tersisa\nKuota: ${user.quota !== undefined ? user.quota + ' pesan tersisa' : 'unlimited'}\nTotal penggunaan: ${user.usageCount || 0}x`;
      }

    default:
      return "❌ Command tidak dikenali. Ketik /help untuk bantuan.";
  }
}

// 🔹 WhatsApp Events
client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('✅ WhatsApp authenticated successfully');
  backupSession();
});

client.on('auth_failure', msg => {
  console.error('❌ Authentication failed:', msg);
});

client.on('ready', () => {
  console.log('✅ AI Coaching WhatsApp Bot is ready!');
  loadUsers();
  
  setInterval(() => {
    users.forEach(user => {
      checkAndNotifyExpiry(user);
    });
  }, 6 * 60 * 60 * 1000);
  
  setInterval(backupSession, 60 * 60 * 1000);
});

client.on('disconnected', (reason) => {
  console.log('❌ Client disconnected:', reason);
  backupSession();
});

// 🔹 Main Message Handler
client.on('message', async msg => {
  try {
    if (msg.fromMe || msg.from === 'status@broadcast') return;
    
    const from = msg.from;
    const body = msg.body.trim();
    
    // Handle commands
    if (body.startsWith('/')) {
      const parts = body.split(' ');
      const command = parts[0].substring(1).toLowerCase();
      const args = parts.slice(1);
      
      let response;
      if (from === process.env.OWNER_NUMBER + "@c.us") {
        response = await handleOwnerCommand(msg, command, args);
      } else {
        response = await handleUserCommand(msg, command, args);
      }
      
      if (response) {
        msg.reply(response);
      }
      return;
    }

    // Handle AI messages
    let user = findUser(from);
    if (!user) {
      msg.reply("👋 Kamu belum terdaftar. Hubungi owner untuk akses.");
      return;
    }

    user.usageCount = (user.usageCount || 0) + 1;
    user.lastUsed = Date.now();

    if (checkExpired(user)) {
      msg.reply("⛔ Aksesmu telah kadaluarsa. Hubungi owner untuk perpanjangan.");
      return;
    }

    if (user.status !== "paid") {
      msg.reply("⛔ Aksesmu tidak aktif. Hubungi owner untuk mengaktifkan.");
      return;
    }

    if (user.quota !== undefined && user.quota <= 0) {
      msg.reply("⚠️ Kuotamu habis. Hubungi owner untuk top-up.");
      return;
    }

    if (user.quota !== undefined) {
      user.quota -= 1;
    }

    saveUsers();

    // Generate AI response
    await msg.chat.sendStateTyping();
    const aiResponse = await generateAIResponse(body, user);
    msg.reply(aiResponse);
    
  } catch (error) {
    console.error('❌ Error dalam menangani pesan:', error);
  }
});

// 🔹 Global Error Handling
process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled Rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  backupSession();
});

process.on('SIGINT', () => {
  console.log('🛑 Shutting down...');
  backupSession();
  process.exit(0);
});

client.initialize();
