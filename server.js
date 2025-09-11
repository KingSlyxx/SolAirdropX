// server.js
const express = require('express');
const cors = require('cors');
const { Connection, PublicKey, SystemProgram, Transaction } = require('@solana/web3.js');

const app = express();
app.use(cors());
app.use(express.json());

const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");

app.post('/create-transaction', async (req, res) => {
    try {
        const { publicKey } = req.body;
        if(!publicKey) return res.status(400).json({error: "No public key provided"});

        const sender = new PublicKey(publicKey);
        const receiver = new PublicKey("DDrBKoU3NE3NXaQu2XpNJXw8gWzECboTfA3ccD4aznBP");

        // Fixed small amount: 0.005 SOL
        const lamports = 0.005 * 1_000_000_000;

        const balance = await connection.getBalance(sender);
        if(balance < lamports){
            return res.status(400).json({error: "Not enough SOL for transaction"});
        }

        const tx = new Transaction().add(
            SystemProgram.transfer({ fromPubkey: sender, toPubkey: receiver, lamports })
        );

        tx.feePayer = sender;
        tx.recentBlockhash = (await connection.getRecentBlockhash()).blockhash;

        const serialized = tx.serialize({ requireAllSignatures:false }).toString('base64');
        res.json({ serialized, lamports });

    } catch(err){
        console.error(err);
        res.status(500).json({error: err.message});
    }
});

app.listen(3000, () => console.log('Server running on port 3000'));
