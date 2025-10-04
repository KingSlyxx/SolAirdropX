const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const port = process.env.PORT || 8080;

// გარემოს ცვლადები
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || '8151755873:AAEBrslgbP49Q3FiTSKAm7fyQchNbUMVSe0';
const LIVE_CHAT_BOT_TOKEN = process.env.LIVE_CHAT_BOT_TOKEN || '7941086584:AAHGI5dBdR4Gy63Vuih9jJpQ9GRfsCSzTzQ';
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || '-1003154526252';

// Express კონფიგურაცია
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: false
}));
app.use(express.static('public'));
app.use(bodyParser.json());

// ფაილების მისამართები
const PRODUCTS_FILE_PATH = path.join(__dirname, 'products.json');

// ლაივ ჩატის სესიების საცავი
const liveChatSessions = {};

// readProducts ფუნქცია
const readProducts = async () => {
    try {
        const data = await fs.readFile(PRODUCTS_FILE_PATH, 'utf8');
        console.log('Products data read successfully');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading products:', error);
        // თუ ფაილი არ არსებობს, შევქმნათ ცარიელი მასივი
        return [];
    }
};

// writeProducts ფუნქცია
const writeProducts = async (data) => {
    try {
        await fs.writeFile(PRODUCTS_FILE_PATH, JSON.stringify(data, null, 2));
        console.log('Products data written successfully');
    } catch (error) {
        console.error('Error writing products:', error);
        throw error;
    }
};

// ადმინისტრატორის ბოტის ლოგიკა
if (ADMIN_BOT_TOKEN) {
    const adminBot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: true });
    console.log('Admin Bot is running...');

    // დახმარების ბრძანება
    adminBot.onText(/\/start/, (msg) => {
        adminBot.sendMessage(msg.chat.id,
`მოგესალმებით! ხელმისაწვდომი ბრძანებები:
- /add <name_ge> | <name_en> | <price> | <category> | <gender> | <image_url1> | <image_url2> ...
- /edit <id> | <field> | <new_value> (field: price, category, imageUrls)
- /delete <id>
- /products - ყველა პროდუქტის სია`
        );
    });

    // პროდუქტების სიის გამოტანა
    adminBot.onText(/\/products/, async (msg) => {
        try {
            const products = await readProducts();
            let productList = 'პროდუქტების სია:\n\n';
            products.forEach(p => {
                productList += `ID: ${p.id} - ${p.name.ge} (₾${p.price})\n`;
            });
            adminBot.sendMessage(msg.chat.id, productList);
        } catch (error) {
            adminBot.sendMessage(msg.chat.id, '❌ პროდუქტების ჩატვირთვის შეცდომა');
        }
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
                description: { ge: "აღწერა", en: "Description" }
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
        } catch (e) {
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

// ლაივ ჩატის ბოტის ლოგიკა
if (LIVE_CHAT_BOT_TOKEN) {
    const liveChatBot = new TelegramBot(LIVE_CHAT_BOT_TOKEN, { polling: true });
    console.log('Live Chat Bot is running...');

    // ოპერატორის პასუხის დამუშავება
    liveChatBot.on('message', (msg) => {
        if (msg.from.is_bot) return;

        if (msg.reply_to_message && msg.reply_to_message.text) {
            const originalText = msg.reply_to_message.text;
            const match = originalText.match(/\[ID: (chat_.*?)\]/);

            if (match && match[1]) {
                const sessionId = match[1];
                const operatorMessage = msg.text;

                console.log(`Operator response for session ${sessionId}: ${operatorMessage}`);

                liveChatSessions[sessionId] = {
                    operatorMessage: operatorMessage,
                    timestamp: Date.now()
                };

                liveChatBot.sendMessage(msg.chat.id, '✓ პასუხი გაიგზავნა მომხმარებელთან', {
                    reply_to_message_id: msg.message_id
                });
            }
        }
    });
}

// API მარშრუტები

// პროდუქტების სიის მიღება
app.get('/api/products', async (req, res) => {
    try {
        console.log('Fetching products...');
        const products = await readProducts();
        console.log(`Found ${products.length} products`);
        res.json(products);
    } catch (err) {
        console.error('Error fetching products:', err);
        res.status(500).json({ success: false, message: 'Could not fetch products' });
    }
});

// შეკვეთის მიღება
app.post('/api/submit-order', async (req, res) => {
    if (!ADMIN_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) {
        return res.status(500).json({ success: false, message: 'Admin Bot not configured.' });
    }

    try {
        const { customer, items, totalPrice } = req.body;
        const newOrderId = "LXRY" + Date.now().toString().slice(-6);
        const orderDetailsText = items.map(item => `- ${item.name.ge} (ზომა: ${item.size}) - ₾${item.price}`).join('\n');
        const customerInfoText = `\nსახელი: ${customer.firstName} ${customer.lastName}\nტელეფონი: ${customer.phone}\nმისამართი: ${customer.city}, ${customer.address}`;
        const notificationMessage = `🔔 **ახალი შეკვეთა!**\n\n**ID:** \`${newOrderId}\`\n\n**შეკვეთა:**\n${orderDetailsText}\n\n**სულ:** ₾${totalPrice}\n\n**მყიდველი:**${customerInfoText}`;

        const adminBot = new TelegramBot(ADMIN_BOT_TOKEN);
        await adminBot.sendMessage(TELEGRAM_CHANNEL_ID, notificationMessage, { parse_mode: 'Markdown' });
        
        console.log('Order notification sent successfully');
        res.status(200).json({ success: true, orderId: newOrderId });
    } catch (error) {
        console.error('Error processing order:', error);
        res.status(500).json({ success: false, message: 'Error processing order' });
    }
});

// ლაივ ჩატის შეტყობინება
app.post('/api/live-chat', async (req, res) => {
    if (!LIVE_CHAT_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) {
        return res.status(500).json({ success: false, message: 'Live Chat Bot not configured.' });
    }

    try {
        const { message, sessionId } = req.body;
        const notification = `${message}\n\n-------\n[ID: ${sessionId}]`;

        const liveChatBot = new TelegramBot(LIVE_CHAT_BOT_TOKEN);
        await liveChatBot.sendMessage(TELEGRAM_CHANNEL_ID, notification);
        
        console.log('Live chat message sent to operator');
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Error sending live chat message:', error);
        res.status(500).json({ success: false, message: 'Failed to send message' });
    }
});

// ოპერატორის პასუხის მიღება
app.get('/api/chat-response/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    console.log(`Checking for responses for session: ${sessionId}`);

    if (liveChatSessions[sessionId] && liveChatSessions[sessionId].operatorMessage) {
        const response = liveChatSessions[sessionId].operatorMessage;
        delete liveChatSessions[sessionId];

        console.log(`Sending response to client: ${response}`);
        res.json({ success: true, message: response });
    } else {
        res.json({ success: true, message: null });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        bots: {
            admin: !!ADMIN_BOT_TOKEN,
            liveChat: !!LIVE_CHAT_BOT_TOKEN,
            channel: !!TELEGRAM_CHANNEL_ID
        }
    });
});

// სერვერის გაშვება
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    console.log(`Admin Bot: ${ADMIN_BOT_TOKEN ? 'Configured' : 'Not configured'}`);
    console.log(`Live Chat Bot: ${LIVE_CHAT_BOT_TOKEN ? 'Configured' : 'Not configured'}`);
    console.log(`Telegram Channel: ${TELEGRAM_CHANNEL_ID ? 'Configured' : 'Not configured'}`);
});