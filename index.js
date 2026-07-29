const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const TelegramToken = "8890131325:AAG2SAW8cG1x8yH2U-uyHfPtrmsyNpcvb9w";
const TelegramChatId = "-5308116981";
const SECONDARY_URL = "https://bridgeserver1-ydt4.onrender.com";
const ADMIN_USER_ID = "9271966310";

const activeSessions = {};

function escapeHTML(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

async function sendTelegramNotification(htmlMessage, targetChatId = TelegramChatId) {
    if (!TelegramToken || !targetChatId) {
        console.error("Telegram Token or Chat ID is missing!");
        return;
    }
    const chatId = String(targetChatId).trim();
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
    const senderName = req.body.playerName || req.body.Sender;
    const targetUser = req.body.TargetUser;
    const broadcastPayload = JSON.stringify(req.body);
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            if (client.playerName !== senderName) {
                if (req.body.Type === "Announcement") {
                    client.send(broadcastPayload);
                } else if (targetUser) {
                    if (client.playerName === targetUser || String(client.userId) === String(targetUser) || String(client.userId) === ADMIN_USER_ID) {
                        client.send(broadcastPayload);
                    }
                }
            }
        }
    });
    res.sendStatus(200);
});

app.post('/send-to-telegram', async (req, res) => {
    const { playerName, userId, message } = req.body;
    const safeName = escapeHTML(playerName);
    const safeUserId = escapeHTML(String(userId));
    const safeMessage = escapeHTML(message);

    let targetChatId = TelegramChatId;
    let isDirectReply = false;

    for (const [cId, uId] of Object.entries(activeSessions)) {
        if (String(uId) === String(safeUserId)) {
            targetChatId = cId;
            isDirectReply = true;
            break;
        }
    }

    let telegramFormattedText = "";
    if (isDirectReply) {
        telegramFormattedText = 
            `📥 <b>Received From Roblox (ID ${safeUserId})</b>: "${safeMessage}"\n` +
            `👤 <b>User:</b> ${safeName}\n` +
            `💬 <a href="https://t.me/Obsidian_WardenBot?start=reply_${safeUserId}">Click here to Reply to ID ${safeUserId}</a>`;
    } else {
        telegramFormattedText = 
            `💡 <b>NEW TELEGRAM BROADCAST / SUGGESTION</b>\n` +
            `👤 <b>User:</b> ${safeName} (ID: <code>${safeUserId}</code>)\n` +
            `📝 <b>Message:</b> ${safeMessage}\n` +
            `💬 <a href="https://t.me/Obsidian_WardenBot?start=reply_${safeUserId}">Click here to Reply to ID ${safeUserId}</a>`;
    }

    await sendTelegramNotification(telegramFormattedText, targetChatId);
    res.sendStatus(200);
});

app.post('/telegram-webhook', async (req, res) => {
    res.sendStatus(200);

    const update = req.body;
    console.log("Incoming Telegram Webhook Update:", JSON.stringify(update));

    if (update && update.message && update.message.text) {
        const message = update.message;
        const chatId = message.chat.id;
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

        let targetUser = activeSessions[chatId] || "";
        let replyText = commandPayload;
        let shouldBroadcast = false;
        let isGlobalAnnouncement = false;

        if (commandName === "announce" || commandName === "broadcast") {
            replyText = commandPayload.trim();
            isGlobalAnnouncement = true;
        } else if (commandName === "reply") {
            const payloadParts = commandPayload.trim().split(" ");
            targetUser = payloadParts[0] || "";
            replyText = payloadParts.slice(1).join(" ") || "";
            if (targetUser) {
                activeSessions[chatId] = targetUser;
                shouldBroadcast = true;
            }
        } else if (commandName === "start" && (commandPayload.startsWith("reply=") || commandPayload.startsWith("reply_"))) {
            targetUser = commandPayload.replace("reply=", "").replace("reply_", "").trim();
            if (targetUser) {
                activeSessions[chatId] = targetUser;
            }
            replyText = "Reply session initialized for user ID " + targetUser;
        } else if (commandName === "end" || commandName === "stop" || commandName === "close") {
            const payloadParts = commandPayload.trim().split(" ");
            targetUser = payloadParts[0] || activeSessions[chatId] || "";
            delete activeSessions[chatId];
            replyText = "Reply session ended.";
            shouldBroadcast = true;
        } else if (!commandName && activeSessions[chatId]) {
            targetUser = activeSessions[chatId];
            replyText = telegramText;
            shouldBroadcast = true;
        }

        let responseMessage = "";
        if (commandName === "start") {
            if (targetUser) {
                responseMessage = `✅ Reply session active for user ID: <b><code>${escapeHTML(targetUser)}</code></b>.\nType your message to send it.`;
            } else {
                responseMessage = `🤖 <b>Obsidian Warden Bot Online</b>\nServer operational status is normal.`;
            }
        } else if (commandName === "instructionshowtoreply") {
            responseMessage = `📖 <b>Bot Instructions & Commands:</b>\n\n` +
                `• <code>/start</code> - Initialize bot status or start an active user reply session via deep link\n` +
                `• <code>/instructionshowtoreply</code> - Show instructions on how to reply to specific Roblox players using their user IDs\n` +
                `• <code>/reply</code> - Sends a response message to a specific user ID in-game\n` +
                `• <code>/end</code> - Ends and closes the active reply session for a specific user ID\n` +
                `• <code>/announce</code> - Broadcasts a global server announcement to all connected clients`;
        } else if (commandName === "announce" || commandName === "broadcast") {
            if (replyText) {
                responseMessage = `📢 Global announcement broadcasted: "${escapeHTML(replyText)}"`;
            } else {
                responseMessage = `⚠️ Usage error. Format: <code>/announce [Message]</code>`;
            }
        } else if (commandName === "reply") {
            if (targetUser && replyText) {
                responseMessage = `📤 Reply dispatched to user ID <b><code>${escapeHTML(targetUser)}</code></b>: "${escapeHTML(replyText)}"`;
            } else {
                responseMessage = `⚠️ Usage error. Format: <code>/reply [UserId] [Message]</code>`;
            }
        } else if (commandName === "end" || commandName === "stop" || commandName === "close") {
            responseMessage = `🛑 Reply session closed.`;
        } else if (shouldBroadcast && targetUser) {
            responseMessage = `📤 Sent to Roblox (ID ${targetUser}): "${escapeHTML(replyText)}"`;
        }

        if (responseMessage) {
            await sendTelegramNotification(responseMessage, chatId);
        }

        if (isGlobalAnnouncement && replyText) {
            const announcementPayload = {
                Type: "Announcement",
                Title: "Server Announcement",
                Message: replyText
            };

            console.log("Broadcasting global announcement from Telegram to all clients:", announcementPayload);

            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(announcementPayload));
                }
            });

            try {
                await fetch(`${SECONDARY_URL}/push-to-roblox`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(announcementPayload)
                });
            } catch (err) {
                console.error("Failed to push announcement to Server 2:", err.message);
            }
        } else if (shouldBroadcast && targetUser) {
            const broadcastPayload = {
                Type: "TelegramCommand",
                Command: commandName || "text_reply",
                Sender: senderName,
                UserId: senderUserId,
                Message: telegramText,
                Payload: commandPayload,
                TargetUser: targetUser,
                ReplyText: replyText
            };

            console.log("Broadcasting targeted command to Roblox client:", broadcastPayload);

            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    if (client.playerName === targetUser || String(client.userId) === String(targetUser) || String(client.userId) === ADMIN_USER_ID) {
                        client.send(JSON.stringify(broadcastPayload));
                    }
                }
            });

            try {
                await fetch(`${SECONDARY_URL}/push-to-roblox`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(broadcastPayload)
                });
            } catch (err) {
                console.error("Failed to push command to Server 2:", err.message);
            }
        }
    }
});

wss.on('connection', (ws) => {
    ws.room = 'EN';
    ws.playerName = 'Unknown';
    ws.userId = 'N/A';
    ws.role = 'CHAT';
    ws.messageCount = 0;

    ws.on('message', async (data) => {
        const msgStr = typeof data === 'string' ? data : data.toString();

        if (msgStr.startsWith("JOIN:")) {
            const parts = msgStr.split(":");
            ws.room = parts[1] || 'EN';
            ws.playerName = parts[2] || 'Unknown';
            ws.role = parts[3] || "CHAT"; 
            ws.userId = parts[4] || 'N/A';
            console.log(`${ws.playerName} (ID: ${ws.userId}) joined room on Server 2: [${ws.room}] as ${ws.role}`);
            return;
        }

        ws.messageCount++;
        if (ws.messageCount > 5) {
            console.log(`Player ${ws.playerName} exceeded the 5-message limit.`);
            ws.send(JSON.stringify({ Type: "Error", Message: "Message limit reached. You can only send a maximum of 5 messages." }));
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
