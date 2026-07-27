const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const express = require('express');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => res.send('Bridge Online'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const TelegramToken = "8890131325:AAG2SAW8cG1x8yH2U-uyHfPtrmsyNpcvb9w";
const TelegramChatId = "-5308116981";

function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

async function sendTelegramNotification(htmlMessage) {
    if (!TelegramToken || !TelegramChatId) {
        return;
    }

    const chatId = TelegramChatId.trim();
    const encodedText = encodeURIComponent(htmlMessage);
    const url = `https://api.telegram.org/bot${TelegramToken}/sendMessage?chat_id=${chatId}&text=${encodedText}&parse_mode=HTML`;

    try {
        if (typeof fetch !== 'undefined') {
            const response = await fetch(url, { method: 'POST' });
            const data = await response.json();
            console.log("Telegram Response:", data);

            if (!data.ok) {
                const plainMessage = htmlMessage.replace(/<[^>]*>?/gm, '');
                const encodedPlain = encodeURIComponent(plainMessage);
                const fallbackUrl = `https://api.telegram.org/bot${TelegramToken}/sendMessage?chat_id=${chatId}&text=${encodedPlain}`;

                const fallbackResponse = await fetch(fallbackUrl, { method: 'POST' });
                const fallbackData = await fallbackResponse.json();
                console.log("Telegram Fallback Response:", fallbackData);
            }
            return;
        }
    } catch (err) {
        console.error("Telegram Dispatch Error:", err.message);
    }
}

app.post('/telegram-webhook', (req, res) => {
    const update = req.body;

    if (update && update.message && update.message.text) {
        const senderName = update.message.from.first_name || "Admin";
        const telegramText = update.message.text;

        console.log(`Received from Telegram (${senderName}): ${telegramText}`);

        const broadcastPayload = JSON.stringify({
            Type: "TelegramBroadcast",
            Sender: senderName,
            Message: telegramText
        });

        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(broadcastPayload);
            }
        });
    }

    res.sendStatus(200);
});

wss.on('connection', (ws) => {
    ws.room = 'EN'; 
    ws.on('message', (data) => {
        const msg = data.toString();

        if (msg.startsWith("JOIN:")) {
            const newRoom = msg.split(":")[1];
            ws.room = newRoom;
            console.log(`User moved to channel: ${newRoom}`);
            return;
        }

        if (msg.includes("TelegramBroadcast") || msg.includes("ObsidianSuggest")) {
            try {
                const packet = typeof msg === 'string' ? JSON.parse(msg) : msg;
                const messageText = packet.Message || packet.Suggestion || "No message content provided";

                const safeName = escapeHTML(packet.PlayerName || ws.playerName || 'Unknown');
                const safeUserId = escapeHTML(String(packet.UserId || ws.userId || 'N/A'));
                const safeMessage = escapeHTML(messageText);

                const telegramFormattedText = 
                    `💡 <b>NEW TELEGRAM BROADCAST</b>\n` +
                    `👤 <b>User:</b> ${safeName} (ID: <code>${safeUserId}</code>)\n` +
                    `📝 <b>Message:</b> ${safeMessage}`;

                sendTelegramNotification(telegramFormattedText);
            } catch (e) {
                console.error("Message Parse Error:", e.message);
            }
            return;
        }

        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN && client.room === ws.room) {
                client.send(msg);
            }
        });
    });
});

server.listen(PORT, () => console.log(`Bridge running on ${PORT}`));
