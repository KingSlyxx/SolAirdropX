// server.js (სრულიად განახლებული ვერსია)

const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const fs = require('fs').promises; // ვიყენებთ fs.promises-ს ასინქრონული ოპერაციებისთვის
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// --- გარემოს ცვლადები (Environment Variables) ---
// გამოიყენეთ თქვენს მიერ მოწოდებული ტოკენები და ID
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const LIVE_CHAT_BOT_TOKEN = process.env.LIVE_CHAT_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// --- Express-ის კონფიგურაცია ---
app.use(cors());
app.use(express.static('public')); 
app.use(bodyParser.json());

// --- პროდუქტების ფაილის მისამართი ---
const PRODUCTS_FILE_PATH = path.join(__dirname, 'products.json');

// --- ლაივ ჩატის სესიების საცავი ---
// key: sessionId, value: { operatorMessage: 'some text' }
const liveChatSessions = {};


// =================================================================
// 1. ადმინისტრატორის ბოტის ლოგიკა (პროდუქტების მართვა)
// =================================================================
if (ADMIN_BOT_TOKEN) {
    const adminBot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: true });
    console.log('Admin Bot is running...');

    const readProducts = async () => JSON.parse(await fs.readFile(PRODUCTS_FILE_PATH, 'utf8'));
    const writeProducts = async (data) => await fs.writeFile(PRODUCTS_FILE_PATH, JSON.stringify(data, null, 2));

    // დახმარების ბრძანება
    adminBot.onText(/\/start/, (msg) => {
        adminBot.sendMessage(msg.chat.id, 
`მოგესალმებით! ხელმისაწვდომი ბრძანებები:
- \`/add <name_ge> | <name_en> | <price> | <category> | <gender> | <image_url1> | <image_url2> ...\`
- \`/edit <id> | <field> | <new_value>\` (field: price, category, imageUrls)
- \`/delete <id>\`
- \`/products\` - ყველა პროდუქტის სია`
        );
    });

    // პროდუქტების სიის გამოტანა
    adminBot.onText(/\/products/, async (msg) => {
        const products = await readProducts();
        let productList = 'პროდუქტების სია:\n\n';
        products.forEach(p => {
            productList += `ID: ${p.id} - ${p.name.ge} (₾${p.price})\n`;
        });
        adminBot.sendMessage(msg.chat.id, productList);
    });

    // პროდუქტის დამატება
    adminBot.onText(/\/add (.+)/, async (msg, match) => {
        try {
            const args = match[1].split('|').map(arg => arg.trim());
            if (args.length < 6) throw new Error('არასაკმარისი არგუმენტები.');

            const [name_ge, name_en, price, category, gender, ...imageUrls] = args;
            const products = await readProducts();
            const newId = products.length > 0 ? Math.max(...products.map(p => p.id)) + 1 : 1;
            
            const newProduct = {
                id: newId,
                name: { ge: name_ge, en: name_en },
                price: parseFloat(price).toFixed(2),
                category: category,
                gender: gender,
                imageUrls: imageUrls,
                sizes: ["XS", "S", "M", "L", "XL", "XXL"],
                description: { ge: "", en: "" }
            };

            products.push(newProduct);
            await writeProducts(products);
            adminBot.sendMessage(msg.chat.id, `✅ პროდუქტი (ID: ${newId}) წარმატებით დაემატა.`);
        } catch (e) {
            adminBot.sendMessage(msg.chat.id, `❌ შეცდომა: ${e.message}`);
        }
    });

    // პროდუქტის რედაქტირება
    adminBot.onText(/\/edit (\d+) \| (.+) \| (.+)/, async (msg, match) => {
        try {
            const id = parseInt(match[1]);
            const field = match[2].trim();
            const value = match[3].trim();
            
            const products = await readProducts();
            const productIndex = products.findIndex(p => p.id === id);
            if (productIndex === -1) throw new Error('პროდუქტი ამ ID-ით ვერ მოიძებნა.');

            if (field === 'price') {
                products[productIndex].price = parseFloat(value).toFixed(2);
            } else if (field === 'category') {
                products[productIndex].category = value;
            } else if (field === 'imageUrls') {
                products[productIndex].imageUrls = value.split(',').map(url => url.trim());
            } else {
                throw new Error('რედაქტირებადი ველი არასწორია (price, category, imageUrls).');
            }

            await writeProducts(products);
            adminBot.sendMessage(msg.chat.id, `✅ პროდუქტი (ID: ${id}) განახლდა.`);
        } catch(e) {
            adminBot.sendMessage(msg.chat.id, `❌ შეცდომა: ${e.message}`);
        }
    });

    // პროდუქტის წაშლა
    adminBot.onText(/\/delete (\d+)/, async (msg, match) => {
        try {
            const id = parseInt(match[1]);
            const products = await readProducts();
            const updatedProducts = products.filter(p => p.id !== id);

            if (products.length === updatedProducts.length) {
                throw new Error('პროდუქტი ამ ID-ით ვერ მოიძებნა.');
            }

            await writeProducts(updatedProducts);
            adminBot.sendMessage(msg.chat.id, `✅ პროდუქტი (ID: ${id}) წაიშალა.`);
        } catch (e) {
            adminBot.sendMessage(msg.chat.id, `❌ შეცდომა: ${e.message}`);
        }
    });
}

// =================================================================
// 2. ლაივ ჩატის ბოტის ლოგიკა (ორმხრივი კომუნიკაცია)
// =================================================================
if (LIVE_CHAT_BOT_TOKEN) {
    const liveChatBot = new TelegramBot(LIVE_CHAT_BOT_TOKEN, { polling: true });
    console.log('Live Chat Bot is running...');

    // იჭერს ოპერატორის პასუხს (Reply) და ამისამართებს მომხმარებელთან
    liveChatBot.on('message', (msg) => {
        if (msg.reply_to_message && msg.reply_to_message.text) {
            const originalText = msg.reply_to_message.text;
            const match = originalText.match(/\[ID: (chat_.*?)\]/);
            if (match && match[1]) {
                const sessionId = match[1];
                // ვინახავთ ოპერატორის შეტყობინებას, რათა ფრონტენდმა წაიკითხოს
                liveChatSessions[sessionId] = { operatorMessage: msg.text };
                liveChatBot.sendMessage(msg.chat.id, '✓ გაგზავნილია');
            }
        }
    });
}

// =================================================================
// 3. API მარშრუტები (Endpoints)
// =================================================================

// პროდუქტების სიის მიღება
app.get('/api/products', async (req, res) => {
    try {
        const products = await readProducts();
        res.json(products);
    } catch (err) {
        res.status(500).json({ success: false, message: 'Could not fetch products' });
    }
});

// შეკვეთის მიღება (იგზავნება ადმინ ბოტთან)
app.post('/api/submit-order', (req, res) => {
    if (!adminBot || !TELEGRAM_CHANNEL_ID) return res.status(500).json({ success: false, message: 'Admin Bot not configured.' });
    
    const { customer, items, totalPrice } = req.body;
    const newOrderId = "LXRY" + Date.now().toString().slice(-6);
    const orderDetailsText = items.map(item => `- ${item.name.ge} (ზომა: ${item.size}) - ₾${item.price}`).join('\n');
    const customerInfoText = `\nსახელი: ${customer.firstName} ${customer.lastName}\nტელეფონი: ${customer.phone}\nმისამართი: ${customer.city}, ${customer.address}`;
    const notificationMessage = `🔔 **ახალი შეკვეთა!**\n\n**ID:** \`${newOrderId}\`\n\n**შეკვეთა:**\n${orderDetailsText}\n\n**სულ:** ₾${totalPrice}\n\n**მყიდველი:**${customerInfoText}`;
        
    adminBot.sendMessage(TELEGRAM_CHANNEL_ID, notificationMessage, { parse_mode: 'Markdown' });
    res.status(200).json({ success: true, orderId: newOrderId });
});

// ლაივ ჩატის შეტყობინების მიღება მომხმარებლისგან (იგზავნება ჩატის ბოტთან)
app.post('/api/live-chat', (req, res) => {
    if (!liveChatBot || !TELEGRAM_CHANNEL_ID) return res.status(500).json({ success: false, message: 'Live Chat Bot not configured.' });

    const { message, sessionId } = req.body;
    // ვამატებთ სესიის ID-ს, რომ ოპერატორმა პასუხი შეძლოს
    const notification = `${message}\n\n-------\n[ID: ${sessionId}]`;
    
    liveChatBot.sendMessage(TELEGRAM_CHANNEL_ID, notification);
    res.status(200).json({ success: true });
});

// ახალი: ოპერატორის პასუხის გაგზავნა მომხმარებელთან
app.get('/api/chat-response/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    if (liveChatSessions[sessionId]) {
        res.json({ success: true, message: liveChatSessions[sessionId].operatorMessage });
        delete liveChatSessions[sessionId]; // ვშლით, რომ ხელახლა არ გაიგზავნოს
    } else {
        res.json({ success: true, message: null });
    }
});

// --- სერვერის გაშვება ---
app.listen(port, () => {
  console.log(`Server is running on port ${port}`); 
});
