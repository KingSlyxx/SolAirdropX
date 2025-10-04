// server.js (სრული, განახლებული ვერსია)

const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const port = process.env.PORT || 8080;

// --- გარემოს ცვლადები ---
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const LIVE_CHAT_BOT_TOKEN = process.env.LIVE_CHAT_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;

// Express კონფიგურაცია
app.use(cors());
app.use(express.static('public'));
app.use(bodyParser.json());

const PRODUCTS_FILE_PATH = path.join(__dirname, 'products.json');
const ORDERS_FILE_PATH = path.join(__dirname, 'orders.json');

// --- ჩატის სესიების მართვის ობიექტები ---
const liveChatSessions = {};
const activeChats = {};
const operatorSelection = {};
const userState = {};

// --- ფაილთან მუშაობის ასინქრონული ფუნქციები ---
const readFileData = async (filePath, defaultData = '[]') => {
    try {
        await fs.access(filePath);
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data || defaultData);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.writeFile(filePath, defaultData, 'utf8');
            return JSON.parse(defaultData);
        }
        console.error(`Error reading file ${filePath}:`, error);
        throw error;
    }
};

const writeFileData = async (filePath, data) => {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
};

// =================================================================
// 1. ადმინისტრატორის ბოტის ლოგიკა
// =================================================================
let adminBot;
if (ADMIN_BOT_TOKEN) {
    adminBot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: true });
    console.log('Admin Bot is running...');

    const mainMenuKeyboard = {
        keyboard: [
            [{ text: 'პროდუქტების ნახვა' }],
            [{ text: 'პროდუქტის დამატება' }]
        ],
        resize_keyboard: true,
    };

    const resetState = (chatId) => delete userState[chatId];

    adminBot.onText(/\/start/, (msg) => {
        resetState(msg.chat.id);
        adminBot.sendMessage(msg.chat.id, 'მოგესალმებით! აირჩიეთ მოქმედება:', { reply_markup: mainMenuKeyboard });
    });

    adminBot.onText(/პროდუქტების ნახვა/, async (msg) => {
        const products = await readFileData(PRODUCTS_FILE_PATH);
        if (!products || products.length === 0) {
            return adminBot.sendMessage(msg.chat.id, "პროდუქტები არ არის დამატებული.");
        }
        await adminBot.sendMessage(msg.chat.id, "პროდუქტების სია:");
        for (const p of products) {
            const caption = `ID: ${p.id}\nსახელი: ${p.name.ge}\nფასი: ₾${p.price}${p.oldPrice ? ` (ძველი: ₾${p.oldPrice})` : ''}`;
            const inlineKeyboard = {
                inline_keyboard: [[
                    { text: 'რედაქტირება', callback_data: `edit_${p.id}` },
                    { text: 'წაშლა', callback_data: `delete_${p.id}` }
                ]]
            };
            if (p.imageUrls && p.imageUrls.length > 0) {
                try {
                    await adminBot.sendPhoto(msg.chat.id, p.imageUrls[0], { caption, reply_markup: inlineKeyboard });
                } catch (e) {
                    await adminBot.sendMessage(msg.chat.id, `სურათის ჩატვირთვის შეცდომა.\n${caption}`, { reply_markup: inlineKeyboard });
                }
            } else {
                await adminBot.sendMessage(msg.chat.id, caption, { reply_markup: inlineKeyboard });
            }
        }
    });

    adminBot.onText(/პროდუქტის დამატება/, (msg) => {
        userState[msg.chat.id] = { step: 'awaiting_name_ge', product: { name: {}, description: {}, imageUrls: [], qcImageUrls: [] } };
        adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ პროდუქტის სახელი (ქართულად):', { reply_markup: { force_reply: true } });
    });

    adminBot.on('callback_query', async (cb) => {
        // ... (This part remains mostly the same, only edit flow needs slight adjustment if you want to edit qc photos separately) ...
        const msg = cb.message;
        const data = cb.data;
        const [action, ...params] = data.split('_');
        const productId = parseInt(params[0]);

        switch (action) {
            case 'delete':
                adminBot.sendMessage(msg.chat.id, `დარწმუნებული ხართ, რომ გსურთ პროდუქტის (ID: ${productId}) წაშლა?`, {
                    reply_markup: { inline_keyboard: [[{ text: 'კი', callback_data: `confirm-delete_${productId}` }, { text: 'არა', callback_data: 'cancel-delete' }]] }
                });
                break;
            case 'confirm-delete':
                const products = await readFileData(PRODUCTS_FILE_PATH);
                const updatedProducts = products.filter(p => p.id !== productId);
                await writeFileData(PRODUCTS_FILE_PATH, updatedProducts);
                adminBot.editMessageText(`პროდუქტი (ID: ${productId}) წარმატებით წაიშალა.`, { chat_id: msg.chat.id, message_id: msg.message_id });
                break;
            case 'cancel-delete':
                adminBot.editMessageText('წაშლა გაუქმდა.', { chat_id: msg.chat.id, message_id: msg.message_id });
                break;
            case 'edit':
                userState[msg.chat.id] = { step: 'editing_product', productId };
                adminBot.sendMessage(msg.chat.id, `აირჩიეთ რისი რედაქტირება გსურთ (ID: ${productId})`, {
                    reply_markup: { inline_keyboard: [
                        [{ text: 'სახელი (GE)', callback_data: `edit-field_name_ge_${productId}` }, { text: 'სახელი (EN)', callback_data: `edit-field_name_en_${productId}` }],
                        [{ text: 'ფასი', callback_data: `edit-field_price_${productId}` }, { text: 'ძვ. ფასი', callback_data: `edit-field_oldPrice_${productId}` }],
                        [{ text: 'აღწერა (GE)', callback_data: `edit-field_description_ge_${productId}`}, { text: 'აღწერა (EN)', callback_data: `edit-field_description_en_${productId}` }],
                        [{ text: 'ზომები', callback_data: `edit-field_sizes_${productId}` }],
                        [{ text: 'პროდ. სურათები (გადაწერა)', callback_data: `edit-field_imageUrls_${productId}` }],
                        [{ text: 'ხარისხის სურათები (გადაწერა)', callback_data: `edit-field_qcImageUrls_${productId}`}]
                    ]}
                });
                break;
            case 'edit-field':
                const [field, subfield, prodId] = params;
                
                if (field === 'imageUrls') {
                     userState[msg.chat.id] = { step: 'awaiting_edit_images', productId: parseInt(prodId), newImageUrls: [] };
                     adminBot.sendMessage(msg.chat.id, `ატვირთეთ პროდუქტის ახალი ფოტო(ები) (ID: ${prodId}). დასრულების შემდეგ, დაწერეთ 'done'.`);
                } else if (field === 'qcImageUrls') {
                     userState[msg.chat.id] = { step: 'awaiting_edit_qc_images', productId: parseInt(prodId), newQcImageUrls: [] };
                     adminBot.sendMessage(msg.chat.id, `ატვირთეთ ხარისხის ახალი ფოტო(ები) (ID: ${prodId}). დასრულების შემდეგ, დაწერეთ 'done'.`);
                } else {
                    userState[msg.chat.id] = { step: 'awaiting_edit_value', productId: parseInt(prodId), field, subfield };
                    adminBot.sendMessage(msg.chat.id, `შეიყვანეთ ახალი მნიშვნელობა ველისთვის "${field} ${subfield || ''}":`, { reply_markup: { force_reply: true } });
                }
                break;
        }
        adminBot.answerCallbackQuery(cb.id);
    });

    adminBot.on('photo', async (msg) => {
        const chatId = msg.chat.id;
        const state = userState[chatId];
        
        const validSteps = ['awaiting_images', 'awaiting_qc_images', 'awaiting_edit_images', 'awaiting_edit_qc_images'];
        if (!state || !validSteps.includes(state.step)) return;
        
        if (!IMGBB_API_KEY) {
            return adminBot.sendMessage(chatId, 'imgbb.com API გასაღები არ არის მითითებული სერვერზე.');
        }

        try {
            await adminBot.sendMessage(chatId, 'ფოტოს დამუშავება, გთხოვთ მოიცადოთ...');
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            const fileLink = await adminBot.getFileLink(fileId);

            const imageResponse = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const imageBuffer = Buffer.from(imageResponse.data, 'binary');

            const form = new FormData();
            form.append('image', imageBuffer, { filename: 'telegram_photo.jpg' });

            const uploadResponse = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, form, {
                headers: form.getHeaders(),
            });

            if (uploadResponse.data.success) {
                const imageUrl = uploadResponse.data.data.url;
                if(state.step === 'awaiting_images') state.product.imageUrls.push(imageUrl);
                else if(state.step === 'awaiting_qc_images') state.product.qcImageUrls.push(imageUrl);
                else if(state.step === 'awaiting_edit_images') state.newImageUrls.push(imageUrl);
                else if(state.step === 'awaiting_edit_qc_images') state.newQcImageUrls.push(imageUrl);
                
                await adminBot.sendMessage(chatId, `ფოტო წარმატებით აიტვირთა. გამოაგზავნეთ შემდეგი ან დაწერეთ 'done'.`);
            } else {
                throw new Error(uploadResponse.data.error.message);
            }
        } catch (e) {
            console.error('Image upload failed:', e);
            await adminBot.sendMessage(chatId, `ფოტოს ატვირთვა ვერ მოხერხდა: ${e.message}`);
        }
    });

    adminBot.on('message', async (msg) => {
        const commandText = ['პროდუქტების ნახვა', 'პროდუქტის დამატება'];
        if (!msg.text || msg.text.startsWith('/') || commandText.includes(msg.text)) return;
        
        const state = userState[msg.chat.id];
        if (!state) return;

        try {
            switch (state.step) {
                // ADD PRODUCT FLOW
                case 'awaiting_name_ge':
                    state.product.name.ge = msg.text;
                    state.step = 'awaiting_name_en';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ პროდუქტის სახელი (ინგლისურად):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_name_en':
                    state.product.name.en = msg.text;
                    state.step = 'awaiting_price';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ ფასი (მაგ: 129.99):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_price':
                    state.product.price = parseFloat(msg.text).toFixed(2);
                    state.step = 'awaiting_old_price';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ ძველი ფასი (თუ არ აქვს, დაწერეთ 0):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_old_price':
                    state.product.oldPrice = parseFloat(msg.text) > 0 ? parseFloat(msg.text).toFixed(2) : null;
                    state.step = 'awaiting_description_ge';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ პროდუქტის აღწერა (ქართულად):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_description_ge':
                    state.product.description.ge = msg.text;
                    state.step = 'awaiting_description_en';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ პროდუქტის აღწერა (ინგლისურად):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_description_en':
                    state.product.description.en = msg.text;
                    state.step = 'awaiting_category';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ კატეგორია (მაგ: dresses, shirts):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_category':
                    state.product.category = msg.text.toLowerCase();
                    state.step = 'awaiting_gender';
                    adminBot.sendMessage(msg.chat.id, 'მიუთითეთ სქესი (women ან men):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_gender':
                    state.product.gender = msg.text.toLowerCase();
                    state.step = 'awaiting_sizes';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ ზომები მძიმით გამოყოფით (მაგ: S,M,L,42,43):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_sizes':
                    state.product.sizes = msg.text.split(',').map(s => s.trim().toUpperCase());
                    state.step = 'awaiting_images';
                    adminBot.sendMessage(msg.chat.id, "ატვირთეთ პროდუქტის ძირითადი ფოტო(ები) სათითაოდ. დასრულების შემდეგ, დაწერეთ 'done'.");
                    break;
                case 'awaiting_images':
                    if (msg.text.toLowerCase() === 'done') {
                        if (state.product.imageUrls.length === 0) return adminBot.sendMessage(msg.chat.id, "გთხოვთ, მინიმუმ ერთი ძირითადი ფოტო ატვირთოთ.");
                        state.step = 'awaiting_qc_images';
                        adminBot.sendMessage(msg.chat.id, "ახლა ატვირთეთ 'ხარისხის შემოწმების' ფოტო(ები). დასრულების შემდეგ, დაწერეთ 'done'.");
                    }
                    break;
                 case 'awaiting_qc_images':
                    if (msg.text.toLowerCase() === 'done') {
                        // QC photos are optional, so we don't check if the array is empty
                        const products = await readFileData(PRODUCTS_FILE_PATH);
                        const newId = products.length > 0 ? Math.max(...products.map(p => p.id)) + 1 : 1;
                        const newProduct = { id: newId, ...state.product };
                        products.push(newProduct);
                        await writeFileData(PRODUCTS_FILE_PATH, products);
                        adminBot.sendMessage(msg.chat.id, `პროდუქტი (ID: ${newId}) წარმატებით დაემატა.`, { reply_markup: mainMenuKeyboard });
                        resetState(msg.chat.id);
                    }
                    break;
                
                // EDIT PRODUCT FLOW
                case 'awaiting_edit_images':
                     if (msg.text.toLowerCase() === 'done') {
                        if (state.newImageUrls.length === 0) return adminBot.sendMessage(msg.chat.id, "გთხოვთ, მინიმუმ ერთი ახალი ფოტო ატვირთოთ.");
                        const allProds = await readFileData(PRODUCTS_FILE_PATH);
                        const productIndex = allProds.findIndex(p => p.id === state.productId);
                        if (productIndex === -1) throw new Error('Product not found');
                        allProds[productIndex].imageUrls = state.newImageUrls;
                        await writeFileData(PRODUCTS_FILE_PATH, allProds);
                        adminBot.sendMessage(msg.chat.id, `პროდუქტის (ID: ${state.productId}) ფოტოები განახლდა.`);
                        resetState(msg.chat.id);
                     }
                     break;
                case 'awaiting_edit_qc_images':
                     if (msg.text.toLowerCase() === 'done') {
                        const allProds = await readFileData(PRODUCTS_FILE_PATH);
                        const productIndex = allProds.findIndex(p => p.id === state.productId);
                        if (productIndex === -1) throw new Error('Product not found');
                        allProds[productIndex].qcImageUrls = state.newQcImageUrls;
                        await writeFileData(PRODUCTS_FILE_PATH, allProds);
                        adminBot.sendMessage(msg.chat.id, `პროდუქტის (ID: ${state.productId}) ხარისხის ფოტოები განახლდა.`);
                        resetState(msg.chat.id);
                     }
                     break;
                case 'awaiting_edit_value':
                    const allProds = await readFileData(PRODUCTS_FILE_PATH);
                    const productIndex = allProds.findIndex(p => p.id === state.productId);
                    if (productIndex === -1) throw new Error('Product not found');
                    
                    const productToEdit = allProds[productIndex];
                    let value = msg.text;

                    if (['price', 'oldPrice'].includes(state.field)) {
                        value = parseFloat(value).toFixed(2);
                        if (state.field === 'oldPrice' && parseFloat(value) === 0) value = null;
                    } else if (state.field === 'sizes') {
                        value = value.split(',').map(item => item.trim().toUpperCase());
                    }

                    if (state.subfield) {
                        productToEdit[state.field][state.subfield] = value;
                    } else {
                        productToEdit[state.field] = value;
                    }
                    
                    await writeFileData(PRODUCTS_FILE_PATH, allProds);
                    adminBot.sendMessage(msg.chat.id, `პროდუქტი (ID: ${state.productId}) განახლდა.`);
                    resetState(msg.chat.id);
                    break;
            }
        } catch (e) {
            adminBot.sendMessage(msg.chat.id, `დაფიქსირდა შეცდომა: ${e.message}\nსცადეთ თავიდან.`);
            resetState(msg.chat.id);
        }
    });
}

// =================================================================
// 2. ლაივ ჩატის ბოტის ლოგიკა
// =================================================================
let liveChatBot;
if (LIVE_CHAT_BOT_TOKEN) {
    // ... (This section remains unchanged, I'm omitting it for brevity but it should be in your file)
}

// =================================================================
// 3. API მარშრუტები (Endpoints)
// =================================================================
app.get('/api/products', async (req, res) => {
    try {
        const products = await readFileData(PRODUCTS_FILE_PATH);
        res.json(products);
    } catch (err) {
        res.status(500).json({ success: false, message: 'Could not fetch products' });
    }
});

// Removed the `/api/assets` endpoint as it's no longer needed

app.post('/api/submit-order', async (req, res) => {
    // ... (This section remains unchanged)
});

app.get('/api/admin/sales-data', async (req, res) => {
    // ... (This section remains unchanged)
});

app.post('/api/live-chat', async (req, res) => {
    // ... (This section remains unchanged)
});

app.get('/api/chat-response/:sessionId', (req, res) => {
    // ... (This section remains unchanged)
});


app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

// NOTE: The full code for Live Chat and other API routes should be included from your original file. 
// I have omitted them here to focus on the requested changes.
