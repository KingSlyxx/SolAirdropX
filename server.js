// server.js

const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const nodemailer = require('nodemailer');
const cors = require('cors');
const fs = require('fs'); // <-- ფაილურ სისტემასთან სამუშაოდ
const path = require('path'); // <-- ფაილის მისამართთან სამუშაოდ

const app = express();
const port = process.env.PORT || 3000;

// --- Environment Variables (საიდუმლო მონაცემები) ---
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const LIVE_CHAT_BOT_TOKEN = process.env.LIVE_CHAT_BOT_TOKEN;
const NOTIFICATION_CHAT_ID = process.env.NOTIFICATION_CHAT_ID;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;

// ბოტების ინიციალიზაცია
const adminBot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: true });
const liveChatBot = new TelegramBot(LIVE_CHAT_BOT_TOKEN, { polling: true });

// იმეილის გაგზავნის კონფიგურაცია
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS }
});

// Express-ის კონფიგურაცია
app.use(cors());
app.use(express.static('public')); 
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- პროდუქტების მონაცემთა ბაზა (JSON ფაილი) ---
const productsFilePath = path.join(__dirname, 'products.json');
let products = [];

const loadProducts = () => {
    try {
        const data = fs.readFileSync(productsFilePath, 'utf8');
        products = JSON.parse(data);
        console.log("Products loaded from products.json");
    } catch (err) {
        console.error("Error reading products.json:", err);
        products = []; // თუ ფაილი არ არსებობს, დავიწყოთ ცარიელი სიით
    }
};

const saveProducts = () => {
    try {
        fs.writeFileSync(productsFilePath, JSON.stringify(products, null, 2), 'utf8');
        console.log("Products saved to products.json");
    } catch (err) {
        console.error("Error writing to products.json:", err);
    }
};

loadProducts(); // აპლიკაციის გაშვებისას პროდუქტების ჩატვირთვა

let dummyOrders = {
    "12345": "თქვენი შეკვეთა მუშავდება.",
};

// === API მარშრუტები (Routes) ===

// 1. პროდუქტების სიის მიღება
app.get('/api/products', (req, res) => {
    res.json(products);
});

// 2. შეკვეთის მიღება (კოდი უცვლელია)
app.post('/api/submit-order', (req, res) => {
    // ... (თქვენი შეკვეთის მიღების ლოგიკა აქ უცვლელად რჩება)
});

// 3. ლაივ ჩატის შეტყობინების მიღება (კოდი უცვლელია)
app.post('/api/live-chat', (req, res) => {
    // ... (თქვენი ჩატის ლოგიკა აქ უცვლელად რჩება)
});

// 4. შეკვეთის სტატუსის მიღება (კოდი უცვლელია)
app.get('/api/order-status/:orderId', (req, res) => {
    // ... (სტატუსის ლოგიკა აქ უცვლელად რჩება)
});


// === ტელეგრამის ბოტების ლოგიკა ===

// ⭐⭐⭐ ახალი ფუნქცია: პროდუქტის დამატება ტელეგრამიდან ⭐⭐⭐
adminBot.onText(/\/addproduct(.+)/s, (msg, match) => {
    const chatId = msg.chat.id;
    // უსაფრთხოებისთვის, ვამოწმებთ რომ ბრძანება მოდის მხოლოდ ადმინის ჩატიდან
    if (String(chatId) !== NOTIFICATION_CHAT_ID) {
        return adminBot.sendMessage(chatId, "თქვენ არ გაქვთ ამ ბრძანების შესრულების უფლება.");
    }
    
    try {
        const text = match[1].trim();
        const lines = text.split('\n');
        
        const newProduct = {
            name: {},
            description: {}
        };

        lines.forEach(line => {
            const [key, ...valueParts] = line.split(':');
            const value = valueParts.join(':').trim();

            switch (key.trim()) {
                case 'id': newProduct.id = parseInt(value, 10); break;
                case 'name_ge': newProduct.name.ge = value; break;
                case 'name_en': newProduct.name.en = value; break;
                case 'price': newProduct.price = value; break;
                case 'old_price': newProduct.oldPrice = value; break;
                case 'category': newProduct.category = value; break;
                case 'gender': newProduct.gender = value; break;
                case 'sizes': newProduct.sizes = value.split(',').map(s => s.trim()); break;
                case 'image_url': newProduct.imageUrls = [value]; break;
                case 'description_ge': newProduct.description.ge = value; break;
                case 'description_en': newProduct.description.en = value; break;
            }
        });

        // ვამოწმებთ, არის თუ არა ყველა საჭირო ველი შევსებული
        if (!newProduct.id || !newProduct.name.ge || !newProduct.price || !newProduct.category || !newProduct.gender) {
            throw new Error("სავალდებულო ველები (id, name_ge, price, category, gender) არ არის შევსებული.");
        }

        // ვამოწმებთ, ხომ არ არსებობს პროდუქტი იგივე ID-ით
        if (products.some(p => p.id === newProduct.id)) {
            throw new Error(`პროდუქტი ID: ${newProduct.id}-ით უკვე არსებობს.`);
        }
        
        products.push(newProduct);
        saveProducts(); // ვინახავთ განახლებულ სიას ფაილში

        adminBot.sendMessage(chatId, `✅ პროდუქტი "${newProduct.name.ge}" (ID: ${newProduct.id}) წარმატებით დაემატა.`);

    } catch (error) {
        adminBot.sendMessage(chatId, `❌ შეცდომა პროდუქტის დამატებისას:\n${error.message}\n\nგთხოვთ, შეამოწმოთ ფორმატი და სცადოთ თავიდან.`);
    }
});


// სერვერის გაშვება
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
