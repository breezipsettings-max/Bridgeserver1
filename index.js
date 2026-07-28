const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const TelegramToken = "8890131325:AAG2SAW8cG1x8yH2U-uyHfPtrmsyNpcvb9w";
const TelegramChatId = "-5308116981";
const PRIMARY_URL = "https://bridgeserver-0xlb.onrender.com";
const SECONDARY_URL = "https://bridgeserver1-ydt4.onrender.com";

function escapeHTML(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

async function sendTelegramNotification(htmlMessage) {
    if (!TelegramToken || !TelegramChatId) {
        console.error("Telegram Token or Chat ID is missing!");
        return;
    }
    const chatId = TelegramChatId.trim();
    let url = `https://api.telegram.org/bot${TelegramToken}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(htmlMessage)}&parse_mode=HTML`;

    try {
        const response = await fetch(url, { method: 'POST' });
        const data = await response.json();
        
        if (!data.ok) {
            console.error("Telegram API rejected HTML message:", data);
            const plainMessage = htmlMessage.replace(/<[^>]*>?/gm, '');
            let fallbackUrl = `https://api.telegram.org/bot${TelegramToken}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(plainMessage)}`;
            
            const fallbackResponse = await fetch(fallbackUrl, { method: 'POST' });
            const fallbackData = await fallbackResponse.json();
            
            if (!fallbackData.ok) {
                console.error("Telegram API fallback also failed:", fallbackData);
            }
        } else {
            console.log("Telegram message sent successfully!");
        }
    } catch (err) {
        console.error("Telegram Dispatch Network Error:", err);
    }
}

app.get('/', (req, res) => {
    res.send('Server 2 (Backup WS & Telegram Broadcaster) Online');
});

app.post('/push-to-roblox', (req, res) => {
    const broadcastPayload = JSON.stringify(req.body);
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(broadcastPayload);
        }
    });
    res.sendStatus(200);
});

app.post('/send-to-telegram', async (req, res) => {
    const { playerName, userId, message } = req.body;
    const safeName = escapeHTML(playerName);
    const safeUserId = escapeHTML(String(userId));
    const safeMessage = escapeHTML(message);

    const telegramFormattedText = 
        `💡 <b>NEW TELEGRAM BROADCAST / SUGGESTION</b>\n` +
        `👤 <b>User:</b> ${safeName} (ID: <code>${safeUserId}</code>)\n` +
        `📝 <b>Message:</b> ${safeMessage}\n` +
        `💬 <a href="https://t.me/Obsidian_WardenBot?start=reply_${safeUserId}">Click here to Reply to ${safeName}</a>`;

    await sendTelegramNotification(telegramFormattedText);
    res.sendStatus(200);
});

app.post('/telegram-webhook', async (req, res) => {
    const update = req.body;

    if (update && update.message && update.message.text) {
        const message = update.message;
        const firstName = message.from.first_name || "Admin";
        const lastName = message.from.last_name || "";
        const senderName = `${firstName} ${lastName}`.trim();
        const senderUserId = message.from.id;
        const telegramText = message.text;

        let commandName = "";
        let commandPayload = telegramText;

        if (telegramText.startsWith("/")) {
            const parts = telegramText.split(" ");
            let cmdPart = parts[0];
            if (cmdPart.includes("@")) {
                cmdPart = cmdPart.split("@")[0];
            }
            commandName = cmdPart.substring(1).toLowerCase();
            commandPayload = parts.slice(1).join(" ");
        }

        let targetUser = "";
        let replyText = commandPayload;

        if (commandName === "reply") {
            const payloadParts = commandPayload.trim().split(" ");
            targetUser = payloadParts[0] || "";
            replyText = payloadParts.slice(1).join(" ") || "";
        }

        const broadcastPayload = {
            Type: "TelegramCommand",
            Command: commandName,
            Sender: senderName,
            UserId: senderUserId,
            Message: telegramText,
            Payload: commandPayload,
            TargetUser: targetUser,
            ReplyText: replyText
        };

        // Broadcast locally to any clients connected to Server 2
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(broadcastPayload));
            }
        });

        // Backup sync forward to Primary Server
        try {
            await fetch(`${PRIMARY_URL}/push-to-roblox`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(broadcastPayload)
            });
        } catch (err) {
            console.error("Failed to push command to Primary Server:", err.message);
        }
    }

    res.sendStatus(200);
});

wss.on('connection', (ws) => {
    ws.room = 'EN';
    ws.playerName = 'Unknown';
    ws.userId = 'N/A';
    ws.role = 'CHAT';

    ws.on('message', async (data) => {
        const msgStr = typeof data === 'string' ? data : data.toString();

        if (msgStr.startsWith("JOIN:")) {
            const parts = msgStr.split(":");
            ws.room = parts[1] || 'EN';
            ws.playerName = parts[2] || 'Unknown';
            ws.role = parts[3] || "CHAT"; 
            console.log(`${ws.playerName} joined room on Server 2: [${ws.room}] as ${ws.role}`);
            return;
        }

        if (msgStr.includes("TelegramBroadcast") || msgStr.includes("ObsidianSuggest") || msgStr.includes("suggestion")) {
            try {
                let packet;
                try {
                    packet = JSON.parse(msgStr);
                } catch (parseErr) {
                    packet = { 
                        Message: msgStr, 
                        PlayerName: ws.playerName, 
                        UserId: ws.userId 
                    };
                }

                const messageText = packet.Message || packet.Suggestion || packet.Text || msgStr;
                const rawName = packet.PlayerName || ws.playerName || 'Unknown';
                const safeUserId = String(packet.UserId || ws.userId || 'N/A');

                console.log(`Forwarding message from ${rawName} to Telegram via Server 2...`);

                const forwardRes = await fetch(`${SECONDARY_URL}/send-to-telegram`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        playerName: rawName,
                        userId: safeUserId,
                        message: messageText
                    })
                });

                if (!forwardRes.ok) {
                    console.error(`Server 2 send-to-telegram returned status: ${forwardRes.status}`);
                }
            } catch (e) {
                console.error("CRITICAL ERROR in Server 2 WebSocket forwarder:", e);
            }
            return;
        }

        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN && client.room === ws.room) {
                client.send(msgStr);
            }
        });
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Server 2 (Backup WS & Telegram Broadcaster) running on port ${PORT}`);
});
