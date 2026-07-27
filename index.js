const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => res.send('Bridge Online'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const TelegramToken = "8890131325:AAG2SAW8cG1x8yH2U-uyHfPtrmsyNpcvb9w";
const TelegramTChatId = "-5308116981";

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

    const encodedText = encodeURIComponent(htmlMessage);
    const url = `https://api.telegram.org/bot${TelegramToken}/sendMessage?chat_id=${TelegramChatId}&text=${encodedText}&parse_mode=HTML`;

    try {
        if (typeof fetch !== 'undefined') {
            const response = await fetch(url, { method: 'POST' });
            const data = await response.json();
            console.log("Telegram Response:", data);

            if (!data.ok) {
                const plainMessage = htmlMessage.replace(/<[^>]*>?/gm, '');
                const encodedPlain = encodeURIComponent(plainMessage);
                const fallbackUrl = `https://api.telegram.org/bot${TelegramToken}/sendMessage?chat_id=${TelegramChatId}&text=${encodedPlain}`;

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

        if (msg.includes("ObsidianSuggest")) {
            try {
                const packet = typeof msg === 'string' ? JSON.parse(msg) : msg;
                const suggestionText = packet.Suggestion || "No message content provided";

                const safeName = escapeHTML(packet.PlayerName || ws.playerName || 'Unknown');
                const safeUserId = escapeHTML(String(packet.UserId || ws.userId || 'N/A'));
                const safeSuggestion = escapeHTML(suggestionText);

                const telegramFormattedText = 
                    `💡 <b>NEW SUGGESTION RECEIVED</b>\n` +
                    `👤 <b>User:</b> ${safeName} (ID: <code>${safeUserId}</code>)\n` +
                    `📝 <b>Suggestion:</b> ${safeSuggestion}`;

                sendTelegramNotification(telegramFormattedText);
            } catch (e) {
                console.error("Suggestion Parse Error:", e.message);
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
