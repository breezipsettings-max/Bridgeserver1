const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const TelegramToken = "8890131325:AAG2SAW8cG1x8yH2U-uyHfPtrmsyNpcvb9w";
const TelegramChatId = "-5308116981";
const PRIMARY_URL = "https://bridgeserver-0xlb.onrender.com/";
const ADMIN_USER_ID = "9271966310";

const activeSessions = {};
const blacklistedUsers = new Map();


function escapeHTML(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function isBlacklisted(userId) {
    if (!blacklistedUsers.has(userId)) return false;
    const expireTime = blacklistedUsers.get(userId);
    if (Date.now() > expireTime) {
        blacklistedUsers.delete(userId);
        return false;
    }
    return true;
}

async function sendTelegramNotification(htmlMessage, targetChatId = TelegramChatId, replyMarkup = null) {
    if (!TelegramToken || !targetChatId) {
        console.error("Telegram Token or Chat ID is missing!");
        return;
    }
    const chatId = String(targetChatId).trim();
    const payload = {
        chat_id: chatId,
        text: htmlMessage,
        parse_mode: 'HTML'
    };
    if (replyMarkup) {
        payload.reply_markup = replyMarkup;
    }

    try {
        const response = await fetch(`https://api.telegram.org/bot${TelegramToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        
        if (!data.ok) {
            console.error("Telegram API rejected HTML message:", data);
            const plainMessage = htmlMessage.replace(/<[^>]*>?/gm, '');
            payload.text = plainMessage;
            delete payload.parse_mode;
            
            const fallbackResponse = await fetch(`https://api.telegram.org/bot${TelegramToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
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

app.get('/active-players', (req, res) => {
    const clients = [];
    const seenIds = new Set();
    
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            const uId = String(client.userId || "N/A");
            const pName = client.playerName || "Unknown";
            const key = uId !== "N/A" ? uId : pName;
            
            if (!seenIds.has(key)) {
                seenIds.add(key);
                clients.push({
                    playerName: pName,
                    userId: uId,
                    room: client.room || "EN",
                    networkSharing: client.networkSharing !== false,
                    jobId: client.jobId || "",
                    placeId: client.placeId || ""
                });
            }
        }
    });
    res.json(clients);
});

app.post('/push-to-roblox', async (req, res) => {
    const senderName = req.body.playerName || req.body.Sender || "Unknown";
    const senderUserId = String(req.body.userId || req.body.UserId || "N/A");
    const targetUser = req.body.TargetUser;
    const isAnnouncement = req.body.Type === "Announcement";

    if (senderUserId !== "N/A" && isBlacklisted(senderUserId)) {
        return res.status(403).send("Blacklisted");
    }

    if (isAnnouncement && senderUserId !== ADMIN_USER_ID && senderUserId !== "N/A") {
        console.warn(`SECURITY ALERT: Unauthorized action attempted by ${senderName} (ID: ${senderUserId})`);
        
        const oneDayMs = 24 * 60 * 60 * 1000;
        blacklistedUsers.set(senderUserId, Date.now() + oneDayMs);

        const breachAlertText = 
            `⚠️ <b>Unauthorized Admin Action Blocked & User Blacklisted (1 Day)</b>\n` +
            `👤 <b>User:</b> ${escapeHTML(senderName)} (ID: <code>${escapeHTML(senderUserId)}</code>)\n` +
            `⏱️ <b>Duration:</b> 1 Day (24 Hours)\n` +
            `💬 <b>Triggered Message:</b> ` + escapeHTML('"Uh, Oh! Something went wrong." ❌Access Denied! You have no permission to change admin id. Please Don\'t do it again.');

        await sendTelegramNotification(breachAlertText, TelegramChatId);

        const denialPayload = JSON.stringify({
            Type: "Announcement",
            Title: "Access Denied",
            Message: `"Uh, Oh! Something went wrong." ❌Access Denied! You have no permission to change admin id. Please Don't do it again.`
        });

        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN && (String(client.userId) === String(senderUserId) || client.playerName === senderName)) {
                client.send(denialPayload);
                client.close();
            }
        });

        return res.status(403).send("Access Denied");
    }

    const broadcastPayload = JSON.stringify(req.body);
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            if (req.body.Type === "Announcement") {
                client.send(broadcastPayload);
            } else if (client.playerName !== senderName) {
                if (targetUser) {
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

    if (userId && isBlacklisted(String(userId))) {
        return res.sendStatus(403);
    }

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
            `📥 <b>Received From Roblox (ID ${safeUserId})</b>: "${safeMessage}"`;
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
        let isFpnsCommand = false;

        if (commandName === "announce" || commandName === "broadcast") {
            replyText = commandPayload.trim();
            isGlobalAnnouncement = true;
        } else if (commandName === "fpns") {
            isFpnsCommand = true;
        } else if (commandName === "playerlist" || commandName === "playerlists") {
        } else if (commandName === "chooseplayer" || commandName === "choose_player") {
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
        let customInlineKeyboard = null;

        if (commandName === "start") {
            if (targetUser) {
                responseMessage = `✅ Reply session active for user ID: <b><code>${escapeHTML(targetUser)}</code></b>.\nType your message to send it.`;
            } else {
                responseMessage = `🤖 <b>Obsidian Warden Bot Online</b>\nServer operational status is normal.`;
            }
        } else if (commandName === "instructions") {
            responseMessage = `📖 <b>Bot Instructions & Commands:</b>\n\n` +
                `• <code>/start</code> - Initialize bot status or start an active user reply session via deep link\n` +
                `• <code>/instructions</code> - Show instructions on bot commands\n` +
                `• <code>/playerlists</code> - View a clean list of all active connected script users\n` +
                `• <code>/chooseplayer [Number/Name/ID]</code> - Inspect a specific user's detailed profile and network status\n` +
                `• <code>/reply</code> - Sends a response message to a specific user ID in-game\n` +
                `• <code>/end</code> - Ends and closes the active reply session for a specific user ID\n` +
                `• <code>/announce</code> - Broadcasts a global server announcement to all connected clients\n` +
                `• <code>/fpns [Username/UserId]</code> - Force-enable Network Sharing on a target user if criteria match`;
        } else if (commandName === "playerlist" || commandName === "playerlists") {
            let activeClients = [];
            const seenIds = new Set();
            
            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    const uId = String(client.userId || "N/A");
                    const pName = client.playerName || "Unknown";
                    const key = uId !== "N/A" ? uId : pName;
                    
                    if (!seenIds.has(key)) {
                        seenIds.add(key);
                        activeClients.push({
                            playerName: pName,
                            userId: uId,
                            room: client.room || "EN",
                            networkSharing: client.networkSharing !== false,
                            jobId: client.jobId || "",
                            placeId: client.placeId || ""
                        });
                    }
                }
            });

            try {
                const primaryRes = await fetch(`${PRIMARY_URL}/active-players`);
                if (primaryRes.ok) {
                    const remoteClients = await primaryRes.json();
                    if (Array.isArray(remoteClients)) {
                        remoteClients.forEach(rc => {
                            const rId = String(rc.userId || "N/A");
                            const rName = rc.playerName || "Unknown";
                            const rKey = rId !== "N/A" ? rId : rName;
                            
                            if (!seenIds.has(rKey)) {
                                seenIds.add(rKey);
                                activeClients.push(rc);
                            }
                        });
                    }
                }
            } catch (err) {
                console.error("Failed to fetch active players from PRIMARY_URL:", err.message);
            }

            if (activeClients.length === 0) {
                responseMessage = `📋 <b>Connected Script Users List</b>\n\n❌ No active players currently connected.`;
            } else {
                let listText = `📋 <b>Connected Script Users List</b>\n\n`;
                activeClients.forEach((client, index) => {
                    const sName = escapeHTML(client.playerName || "Unknown");
                    const sId = escapeHTML(String(client.userId || "N/A"));
                    const nsStatus = client.networkSharing !== false ? "ON" : "OFF";
                    listText += `${index + 1}. 👤 ${sName} (ID: <code>${sId}</code>) — 📡 Network Sharing: <b>${nsStatus}</b>\n`;
                });
                responseMessage = listText;
            }
        } else if (commandName === "chooseplayer" || commandName === "choose_player") {
            const targetQuery = commandPayload.trim();
            if (!targetQuery) {
                responseMessage = `⚠️ Usage error. Format: <code>/chooseplayer [Number or Username/UserId]</code>`;
            } else {
                let activeClients = [];
                const seenIds = new Set();
                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        const uId = String(client.userId || "N/A");
                        const pName = client.playerName || "Unknown";
                        const key = uId !== "N/A" ? uId : pName;
                        
                        if (!seenIds.has(key)) {
                            seenIds.add(key);
                            activeClients.push({
                                playerName: pName,
                                userId: uId,
                                room: client.room || "EN",
                                networkSharing: client.networkSharing !== false,
                                jobId: client.jobId || "",
                                placeId: client.placeId || "",
                                localClient: client
                            });
                        }
                    }
                });

                try {
                    const primaryRes = await fetch(`${PRIMARY_URL}/active-players`);
                    if (primaryRes.ok) {
                        const remoteClients = await primaryRes.json();
                        if (Array.isArray(remoteClients)) {
                            remoteClients.forEach(rc => {
                                const rId = String(rc.userId || "N/A");
                                const rName = rc.playerName || "Unknown";
                                const rKey = rId !== "N/A" ? rId : rName;
                                
                                if (!seenIds.has(rKey)) {
                                    seenIds.add(rKey);
                                    activeClients.push({ ...rc, localClient: null });
                                }
                            });
                        }
                    }
                } catch (err) {
                    console.error("Failed to fetch active players from PRIMARY_URL for chooseplayer:", err.message);
                }

                let foundClient = null;
                const numIndex = parseInt(targetQuery, 10);
                if (!isNaN(numIndex) && numIndex >= 1 && numIndex <= activeClients.length) {
                    foundClient = activeClients[numIndex - 1];
                } else {
                    for (const client of activeClients) {
                        if (client.playerName.toLowerCase() === targetQuery.toLowerCase() || String(client.userId) === targetQuery) {
                            foundClient = client;
                            break;
                        }
                    }
                }

                if (!foundClient) {
                    responseMessage = "❌ <b>Inspection Error:</b> Player " + escapeHTML(targetQuery) + " was not found in active connections.";
                } else {
                    const fName = escapeHTML(foundClient.playerName || "Unknown");
                    const fId = escapeHTML(String(foundClient.userId || "N/A"));
                    const fRoom = escapeHTML(String(foundClient.room || "EN"));
                    const fNs = foundClient.networkSharing !== false ? "ON" : "OFF";
                    const fJobId = foundClient.jobId || "";
                    const fPlaceId = foundClient.placeId || "";
                    
                    responseMessage = "🔍 <b>Player Profile Inspection</b>\n" +
                        "👤 <b>Name:</b> " + fName + "\n" +
                        "🆔 <b>ID:</b> <code>" + fId + "</code>\n" +
                        "🏠 <b>Lobby/Room:</b> " + fRoom + "\n" +
                        "📡 <b>Network Sharing:</b> <b>" + fNs + "</b>";

                    const buttons = [];
                    if (fJobId && fPlaceId) {
                        buttons.push({ 
                            text: "🔗 Join Server", 
                            url: `https://www.roblox.com/games/start?placeId=${fPlaceId}&jobId=${fJobId}` 
                        });
                    }
                    
                    buttons.push({ 
                        text: "💬 Reply", 
                        url: `https://t.me/Obsidian_WardenBot?start=reply_${fId}` 
                    });

                    customInlineKeyboard = { 
                        inline_keyboard: [buttons] 
                    };
                }
            }
        } else if (commandName === "announce" || commandName === "broadcast") {
            if (!replyText) {
                responseMessage = `⚠️ Usage error. Format: <code>/announce [Message]</code>`;
            }
        } else if (commandName === "fpns") {
            const targetQuery = commandPayload.trim();
            if (!targetQuery) {
                responseMessage = `⚠️ Usage error. Format: <code>/fpns [Username or UserId]</code>`;
            } else {
                let foundTargetClient = null;
                let sameLobbyHasActiveShare = false;

                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        if (client.playerName.toLowerCase() === targetQuery.toLowerCase() || String(client.userId) === targetQuery) {
                            foundTargetClient = client;
                        }
                    }
                });

                if (!foundTargetClient) {
                    responseMessage = `❌ <b>FPNS Error:</b> Target player "${escapeHTML(targetQuery)}" was not found in any active server instance.`;
                } else if (foundTargetClient.networkSharing !== false) {
                    responseMessage = `❌ <b>FPNS Error:</b> Target player <b>${escapeHTML(foundTargetClient.playerName)}</b> already has Network Sharing enabled (or status not OFF).`;
                } else {
                    const targetRoom = foundTargetClient.room;
                    wss.clients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN && client.room === targetRoom && client !== foundTargetClient) {
                            if (client.networkSharing === true) {
                                sameLobbyHasActiveShare = true;
                            }
                        }
                    });

                    if (!sameLobbyHasActiveShare) {
                        responseMessage = `❌ <b>FPNS Error:</b> Lobby validation failed. No other players with Network Sharing ON were found in the same server instance (${targetRoom}).`;
                    } else {
                        const fpnsPayload = JSON.stringify({
                            Type: "FPNS",
                            Title: "You Have turned off Network Sharing Off too Long!",
                            Message: "Heheh! You have been Choisen To let others see you!",
                            Image: "12122426526"
                        });

                        foundTargetClient.send(fpnsPayload);
                        foundTargetClient.networkSharing = true;

                        responseMessage = 
                            `🔮 <b>Force Network Sharing Triggered</b>\n` +
                            `👤 <b>Sender:</b> ${escapeHTML(senderName)} (ID: <code>${escapeHTML(String(senderUserId))}</code>)\n` +
                            `⚡ <b>Status:</b> Successfully forced Network Sharing ON for target user!`;
                    }
                }
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
            await sendTelegramNotification(responseMessage, chatId, customInlineKeyboard);
        }

        if (isGlobalAnnouncement && replyText) {
            const announcementPayload = {
                Type: "Announcement",
                Title: "Server Announcement",
                Message: replyText
            };

            console.log("Broadcasting global announcement from Telegram to all clients:", announcementPayload);
            
            let telegramAnnouncementSuccessText = 
                `📢 <b>SYSTEM-WIDE ANNOUNCEMENT</b>\n` +
                `👤 <b>Sender:</b> ${escapeHTML(senderName)} (ID: <code>${escapeHTML(String(senderUserId))}</code>)\n` +
                `📝 <b>Message:</b> "${escapeHTML(replyText)}"\n` +
                `✅ <b>Status:</b> Pushed to all connected clients.`;
            
            await sendTelegramNotification(telegramAnnouncementSuccessText, chatId);

            try {
                await fetch(`${PRIMARY_URL}/push-to-roblox`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(announcementPayload)
                });
            } catch (err) {
                console.error("Failed to push announcement to PRIMARY_URL:", err.message);
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
                await fetch(`${PRIMARY_URL}/push-to-roblox`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(broadcastPayload)
                });
            } catch (err) {
                console.error("Failed to push command to PRIMARY_URL:", err.message);
            }
        }
    }
});

const translationCache = {};

const requestHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache'
};

const interval = setInterval(() => {
    wss.clients.forEach((client) => {
        if (client.isAlive === false) return client.terminate();
        client.isAlive = false;
        client.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(interval);
});

app.get('/json.txt', async (req, res) => {
    const textToTranslate = req.query.text;
    if (!textToTranslate) {
        return res.status(400).json({ error: "Missing text query parameter" });
    }
    
    const targetLang = req.query.target || "en";
    const cacheKey = `${targetLang}_${textToTranslate}`;

    if (translationCache[cacheKey]) {
        console.log(`[HTTP Cache Hit]: ${textToTranslate} -> ${targetLang}`);
        res.setHeader('Content-Type', 'application/json');
        return res.send(JSON.stringify(translationCache[cacheKey].rawBody));
    }
    
    const translateUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(textToTranslate)}`;
    
    try {
        const response = await fetch(translateUrl, { headers: requestHeaders });
        
        if (response.status === 429) {
            console.error("CRITICAL: Google rate limit hit on HTTP endpoint!");
            return res.status(429).json({ error: "Proxy server rate-limited by translation provider." });
        }

        const translationData = await response.json();
        
        let translated = "";
        let sourceCode = "unknown";
        if (translationData && translationData[0]) {
            for (const part of translationData[0]) {
                if (part && part[0]) {
                    translated += part[0];
                }
            }
            sourceCode = translationData[2] || "unknown";
        }

        translationCache[cacheKey] = {
            translated: translated.trim(),
            sourceCode: sourceCode,
            rawBody: translationData
        };

        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify(translationData));
    } catch (e) {
        console.error("json.txt endpoint error:", e);
        res.status(500).json({ error: "Failed to fetch raw translation format" });
    }
});

wss.on('connection', (ws) => {
    ws.room = 'EN' || 'SYSTEM_ONLY';
    ws.playerName = 'Unknown';
    ws.userId = 'N/A';
    ws.role = 'CHAT' || 'SYSTEM';
    ws.messageCount = 0;
    ws.networkSharing = true;
    ws.jobId = '';
    ws.placeId = '';
    ws.outputLang = 'EN';
    ws.translationEnabled = true;
    ws.translateSelf = false;
    ws.isAlive = true;

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', async (data) => {
        const msgStr = typeof data === 'string' ? data : data.toString();

        if (msgStr.startsWith("JOIN:")) {
            const parts = msgStr.split(":");
            ws.room = parts[1] || 'EN';
            ws.playerName = parts[2] || 'Unknown';
            ws.role = parts[3] || "CHAT"; 
            ws.userId = parts[4] || 'N/A';
            ws.jobId = parts[5] || '';
            ws.placeId = parts[6] || '';

            if (ws.userId !== 'N/A' && isBlacklisted(ws.userId)) {
                ws.close();
                return;
            }

            console.log(`${ws.playerName} (ID: ${ws.userId}) joined room on Server 2: [${ws.room}] as ${ws.role}`);
            return;
        }

        let parsed = null;
        try {
            parsed = JSON.parse(msgStr);
        } catch (e) {
        }

        if (parsed) {
            if (parsed.Type === "NetworkSharingUpdate") {
                ws.networkSharing = !!parsed.Enabled;
                return;
            }
            if (parsed.Type === "ConfigUpdate" || parsed.Config || parsed.TRANSLATION_ENABLED !== undefined || parsed.translationEnabled !== undefined) {
                const cfg = parsed.Config || parsed;
                if (cfg.TARGET_LANG || cfg.target) {
                    ws.outputLang = cfg.TARGET_LANG || cfg.target;
                }
                if (cfg.TRANSLATION_ENABLED !== undefined) {
                    ws.translationEnabled = !!cfg.TRANSLATION_ENABLED;
                } else if (cfg.translationEnabled !== undefined) {
                    ws.translationEnabled = !!cfg.translationEnabled;
                }
                if (cfg.TRANSLATE_SELF !== undefined) {
                    ws.translateSelf = !!cfg.TRANSLATE_SELF;
                } else if (cfg.translateSelf !== undefined) {
                    ws.translateSelf = !!cfg.translateSelf;
                }
                console.log(`[Config Sync] Player ${ws.playerName} updated Breezip Config: Lang=${ws.outputLang}, Enabled=${ws.translationEnabled}, Self=${ws.translateSelf}`);
                return;
            }
            if (parsed.jobId || parsed.placeId) {
                if (parsed.jobId) ws.jobId = parsed.jobId;
                if (parsed.placeId) ws.placeId = parsed.placeId;
                return;
            }
            if (parsed.type === "translate_request" || parsed.Type === "translate_request") {
                try {
                    const userId = parsed.userId || ws.userId || 0;
                    const playerName = parsed.playerName || ws.playerName || "Unknown";
                    
                    ws.userId = Number(userId);
                    ws.playerName = playerName;
                    if (parsed.target) {
                        ws.outputLang = parsed.target;
                    }

                    const targetLang = ws.outputLang || "en";
                    const textToTranslate = parsed.modifiedText || parsed.content || parsed.text || "";
                    
                    if (ws.translationEnabled === false) {
                        ws.send(JSON.stringify({
                            type: "translate_response",
                            id: parsed.id,
                            translated: textToTranslate,
                            sourceCode: "unknown",
                            modifiedText: parsed.modifiedText || textToTranslate,
                            content: parsed.content || textToTranslate,
                            colorHex: parsed.colorHex || "00FF00"
                        }));
                        return;
                    }

                    const cacheKey = `${targetLang}_${textToTranslate}`;
                    if (translationCache[cacheKey]) {
                        ws.send(JSON.stringify({
                            type: "translate_response",
                            id: parsed.id,
                            translated: translationCache[cacheKey].translated,
                            sourceCode: translationCache[cacheKey].sourceCode,
                            modifiedText: parsed.modifiedText || textToTranslate,
                            content: parsed.content || textToTranslate,
                            colorHex: parsed.colorHex || "00FF00"
                        }));
                        return;
                    }
                    
                    const translateUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(textToTranslate)}`;
                    const response = await fetch(translateUrl, { headers: requestHeaders });
                    
                    if (response.status === 429) {
                        ws.send(JSON.stringify({ 
                            type: "translate_response", 
                            id: parsed.id, 
                            translated: textToTranslate, 
                            sourceCode: "unknown",
                            modifiedText: parsed.modifiedText || textToTranslate,
                            content: parsed.content || textToTranslate,
                            colorHex: parsed.colorHex || "00FF00"
                        }));
                        return;
                    }

                    const translationData = await response.json();
                    let translated = "";
                    let sourceCode = "unknown";
                    
                    if (translationData && translationData[0]) {
                        for (const part of translationData[0]) {
                            if (part && part[0]) {
                                translated += part[0];
                            }
                        }
                        sourceCode = translationData[2] || "unknown";
                    }
                    
                    const finalTranslated = translated.trim();
                    translationCache[cacheKey] = {
                        translated: finalTranslated,
                        sourceCode: sourceCode,
                        rawBody: translationData
                    };
                    
                    ws.send(JSON.stringify({
                        type: "translate_response",
                        id: parsed.id,
                        translated: finalTranslated,
                        sourceCode: sourceCode,
                        modifiedText: parsed.modifiedText || textToTranslate,
                        content: parsed.content || textToTranslate,
                        colorHex: parsed.colorHex || "00FF00"
                    }));
                } catch (err) {
                    console.error("Server translation packet error:", err);
                }
                return;
            }
        }

        if (msgStr.includes("AntiKickDetected")) {
            try {
                const packet = parsed || JSON.parse(msgStr);
                const antiKickAlert = 
                    `🚨 <b>ANTI-KICK BYPASS DETECTED!</b>\n` +
                    `👤 <b>User:</b> ${escapeHTML(packet.PlayerName || ws.playerName)} (ID: <code>${escapeHTML(String(packet.UserId || ws.userId))}</code>)\n` +
                    `⚠️ <b>Reason:</b> The user is using "anti-kick" and resisted normal termination. Forcing aggressive client crash/ban enforcement!`;
                await sendTelegramNotification(antiKickAlert, TelegramChatId);
            } catch (e) {
                console.error("Error parsing AntiKickDetected packet:", e);
            }
            return;
        }

        if (ws.userId !== 'N/A' && isBlacklisted(ws.userId)) {
            ws.close();
            return;
        }

        if (msgStr.includes("TelegramBroadcast") || msgStr.includes("ObsidianSuggest") || msgStr.includes("suggestion") || msgStr.includes("ObsidianReply")) {
            try {
                let packet = parsed;
                if (!packet) {
                    try {
                        packet = JSON.parse(msgStr);
                    } catch (parseErr) {
                        packet = { 
                            Message: msgStr, 
                            PlayerName: ws.playerName, 
                            UserId: ws.userId 
                        };
                    }
                }

                if (packet.Type === "ObsidianReply" || msgStr.includes("ObsidianReply")) {
                    ws.messageCount++;
                    if (ws.messageCount > 5) {
                        console.log(`Player ${ws.playerName} exceeded the 5-message limit.`);
                        ws.send(JSON.stringify({ Type: "Error", Message: "Message limit reached. You can only send a maximum of 5 messages." }));
                        
                        let targetChatId = null;
                        for (const [cId, uId] of Object.entries(activeSessions)) {
                            if (String(uId) === String(ws.userId)) {
                                targetChatId = cId;
                                delete activeSessions[cId];
                                break;
                            }
                        }

                        const limitReachedText = 
                            `🟡 <b>Session Auto-Closed</b>\n` +
                            `👤 <b>Player:</b> ${escapeHTML(ws.playerName)} (ID: <code>${escapeHTML(String(ws.userId))}</code>)\n` +
                            `⚠️ <b>Reason:</b> Player has reached the maximum limit of 5 replies.`;

                        await sendTelegramNotification(limitReachedText, targetChatId || TelegramChatId);
                        return;
                    }
                }

                const messageText = packet.Message || packet.Suggestion || packet.Text || msgStr;
                const rawName = packet.PlayerName || ws.playerName || 'Unknown';
                const safeUserId = String(packet.UserId || ws.userId || 'N/A');

                if (isBlacklisted(safeUserId)) {
                    ws.close();
                    return;
                }

                console.log(`Forwarding message from ${rawName} to Telegram via Server 2...`);

                const forwardRes = await fetch(`${PRIMARY_URL}/send-to-telegram`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        playerName: rawName,
                        userId: safeUserId,
                        message: messageText
                    })
                });

                if (!forwardRes.ok) {
                    console.error(`PRIMARY_URL send-to-telegram returned status: ${forwardRes.status}`);
                }
            } catch (e) {
                console.error("CRITICAL ERROR in Server 2 WebSocket forwarder:", e);
            }
            return;
        }

        if (msgStr.includes("update_lang")) {
            try {
                const packet = parsed || JSON.parse(msgStr);
                if (packet.target) {
                    ws.outputLang = packet.target;
                    console.log(`[Lang Sync] Player ${ws.playerName || "Unknown"} updated output lang to: [${ws.outputLang}]`);
                }
            } catch (e) {
                console.error("update_lang error:", e);
            }
            return;
        }

        if (msgStr.includes("sign_broadcast") || msgStr.includes("SendMessage_Broadcast")) {
            try {
                const packet = parsed || JSON.parse(msgStr);
                if (packet.playerName) ws.playerName = packet.playerName;
                if (packet.userId) ws.userId = Number(packet.userId);
                if (packet.target) ws.outputLang = packet.target;
                
                const rawText = packet.rawText || packet.content || "";
                const targetLang = ws.outputLang || "en";
                
                let finalTranslated = packet.translatedText || rawText;
                let sourceCode = "unknown";
                
                if (ws.translationEnabled !== false && rawText !== "" && !packet.translatedText) {
                    const cacheKey = `${targetLang}_${rawText}`;
                    if (translationCache[cacheKey]) {
                        finalTranslated = translationCache[cacheKey].translated;
                        sourceCode = translationCache[cacheKey].sourceCode;
                    } else {
                        const translateUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(rawText)}`;
                        const response = await fetch(translateUrl, { headers: requestHeaders });
                        if (response.status !== 429) {
                            const translationData = await response.json();
                            let translated = "";
                            if (translationData && translationData[0]) {
                                for (const part of translationData[0]) {
                                    if (part && part[0]) {
                                        translated += part[0];
                                    }
                                }
                                sourceCode = translationData[2] || "unknown";
                            }
                            finalTranslated = translated.trim() || rawText;
                            translationCache[cacheKey] = {
                                translated: finalTranslated,
                                sourceCode: sourceCode,
                                rawBody: translationData
                            };
                        }
                    }
                }

                const broadcastPacket = JSON.stringify({
                    type: packet.type || "sign_broadcast",
                    playerName: ws.playerName,
                    displayName: packet.displayName || ws.playerName,
                    rawText: rawText,
                    translatedText: finalTranslated,
                    sourceCode: sourceCode,
                    target: ws.outputLang
                });

                console.log(`[Server-Sided Broadcast] ${ws.playerName}: "${rawText}" -> "${finalTranslated}" (Enabled: ${ws.translationEnabled}, Self: ${ws.translateSelf})`);

                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN && client.room === ws.room) {
                        if (client !== ws || ws.translateSelf) {
                            client.send(broadcastPacket);
                        }
                    }
                });
            } catch (e) {
                console.error("SendMessage_Broadcast / sign_broadcast error:", e);
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

// ==========================================
// !!!DO NOT INTERFERE WITH THIS!! 
// !!THIS IS NOT ROBLOX RELATED!!!
/////////////////////////////////////////////

let requestedMapName = "";
let requestedServerName = "";
let requestedDownloadMethod = "";

// SINGLE PARENT URL SERVING THE ENTIRE TABBED DASHBOARD OVERLAY
app.get('/app', (req, res) => {
    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>TF2C FastDL Cloud Control</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body { background-color: #232323; color: #ffffff; font-family: 'Segoe UI', Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
            .warning-banner { color: #ff3333; font-size: 15px; font-weight: bold; text-align: center; margin-bottom: 25px; padding: 12px; border: 2px solid #ff3333; background-color: rgba(255, 51, 51, 0.1); border-radius: 8px; max-width: 550px; text-transform: uppercase; }
            .menu-card { background-color: #2a2a2a; border: 1px solid #444; border-radius: 6px; padding: 25px; margin-bottom: 20px; width: 100%; max-width: 550px; box-sizing: border-box; box-shadow: 0 4px 10px rgba(0,0,0,0.3); text-align: center; }
            .menu-card h3 { margin-top: 0; color: #ff5555; font-size: 20px; margin-bottom: 20px; }
            .menu-button { display: block; width: 100%; padding: 14px; margin: 10px 0; background-color: #3a3a3a; color: white; border: 1px solid #555; border-radius: 4px; font-size: 16px; font-weight: bold; cursor: pointer; text-align: left; transition: background 0.2s; }
            .menu-button:hover { background-color: #4a4a4a; border-color: #ff5555; }
            .form-panel { display: none; text-align: left; }
            .form-container { display: flex; gap: 10px; margin-top: 15px; margin-bottom: 15px; }
            input[type="text"], select { padding: 12px; font-size: 15px; border: 1px solid #555; border-radius: 4px; background-color: #333; color: #fff; flex-grow: 1; outline: none; }
            button.confirm-btn { padding: 12px 24px; font-size: 15px; background-color: #5cb85c; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; }
            button.confirm-btn:hover { background-color: #4cae4c; }
            button.back-btn { background-color: transparent; color: #ff5555; border: none; font-size: 15px; font-weight: bold; cursor: pointer; padding: 0; margin-bottom: 15px; text-align: left; outline: none; }
            button.back-btn:hover { color: #ff3333; text-decoration: underline; }
            .status-box { font-size: 13px; color: #aaaaaa; font-family: monospace; background: #1a1a1a; padding: 10px; border-radius: 4px; border: 1px solid #2d2d2d; margin-top: 5px; }
            .highlight { color: #5cc8ff; font-weight: bold; }
        </style>
    </head>
    <body>
        <div class="warning-banner">
            ⚠️ WARNING: THIS IS A TF2C FASTDL SYSTEM. THIS IS NOT A ROBLOX SITE OR SERVICE!
        </div>

        <!-- MAIN SELECTION SECTOR -->
        <div id="mainMenu" class="menu-card">
            <h3>TF2C Downloader Control Panel</h3>
            <button class="menu-button" onclick="openPanel('mapPanel')">🗺️ Add Map to Installation Queue</button>
            <button class="menu-button" onclick="openPanel('serverPanel')">🖥️ Configure Target Server Choice</button>
            <button class="menu-button" onclick="openPanel('methodPanel')">📥 Configure Download Method Option</button>
        </div>

        <!-- 1. MAP QUEUE MANAGEMENT PANEL -->
        <div id="mapPanel" class="menu-card form-panel">
            <button class="back-btn" onclick="openMainMenu()">← Back to Main Menu</button>
            <h3>🗺️ Map Installation Queue</h3>
            <div class="form-container">
                <input type="text" id="mapInput" placeholder="Enter map name (e.g. ctf_doublecross_day)">
                <button class="confirm-btn" onclick="submitMap()">Confirm</button>
            </div>
            <div class="status-box">Active Queue: <span class="highlight" id="lblMap">${requestedMapName || '(None Pending)'}</span></div>
        </div>

        <!-- 2. SERVER SELECTION PANEL -->
        <div id="serverPanel" class="menu-card form-panel">
            <button class="back-btn" onclick="openMainMenu()">← Back to Main Menu</button>
            <h3>🖥️ Target Server Selection</h3>
            <div class="form-container">
                <select id="serverSelect">
                    <option value="EventFall Server" ${requestedServerName === 'EventFall Server' ? 'selected' : ''}>EventFall Server</option>
                    <option value="Knockout Server" ${requestedServerName === 'Knockout Server' ? 'selected' : ''}>Knockout Server</option>
                    <option value="Ponosnaya Bratva" ${requestedServerName === 'Ponosnaya Bratva' ? 'selected' : ''}>Ponosnaya Bratva</option>
                </select>
                <button class="confirm-btn" onclick="submitServer()">Update</button>
            </div>
            <div class="status-box">Active Server: <span class="highlight" id="lblServer">${requestedServerName || 'EventFall Server (Default)'}</span></div>
        </div>

        <!-- 3. DOWNLOAD METHOD PANEL -->
        <div id="methodPanel" class="menu-card form-panel">
            <button class="back-btn" onclick="openMainMenu()">← Back to Main Menu</button>
            <h3>📥 App Execution Option</h3>
            <div class="form-container">
                <select id="downloadSelect">
                    <option value="Through The App" ${requestedDownloadMethod === 'Through The App' ? 'selected' : ''}>Through The App</option>
                    <option value="Through The Browser" ${requestedDownloadMethod === 'Through The Browser' ? 'selected' : ''}>Through The Browser</option>
                </select>
                <button class="confirm-btn" onclick="submitDownload()">Update</button>
            </div>
            <div class="status-box">Active Method: <span class="highlight" id="lblMethod">${requestedDownloadMethod || 'Through The App (Default)'}</span></div>
        </div>

        <script>
            function openPanel(panelId) {
                document.getElementById('mainMenu').style.display = 'none';
                document.querySelectorAll('.form-panel').forEach(p => p.style.display = 'none');
                document.getElementById(panelId).style.display = 'block';
            }
            function openMainMenu() {
                document.querySelectorAll('.form-panel').forEach(p => p.style.display = 'none');
                document.getElementById('mainMenu').style.display = 'block';
            }
            function submitMap() {
                const val = document.getElementById('mapInput').value.trim();
                if (!val) return;
                fetch('/app/submit-map?name=' + encodeURIComponent(val))
                    .then(() => {
                        document.getElementById('lblMap').innerText = val;
                        document.getElementById('mapInput').value = '';
                    });
            }
            function submitServer() {
                const val = document.getElementById('serverSelect').value;
                fetch('/app/submit-server?name=' + encodeURIComponent(val))
                    .then(() => { document.getElementById('lblServer').innerText = val; });
            }
            function submitDownload() {
                const val = document.getElementById('downloadSelect').value;
                fetch('/app/submit-download?name=' + encodeURIComponent(val))
                    .then(() => { document.getElementById('lblMethod').innerText = val; });
            }
        </script>
    </body>
    </html>
    `;
    res.setHeader('Content-Type', 'text/html');
    res.send(htmlContent);
});

// BACKGROUND DATA ENDPOINTS FOR STORAGE SETTING
app.get('/app/submit-map', (req, res) => {
    if (req.query.name) {
        requestedMapName = String(req.query.name).trim().replace(/\.bsp$/i, '').replace(/\.bz2$/i, '');
    }
    res.sendStatus(30000);
});

app.get('/app/submit-server', (req, res) => {
    if (req.query.name) {
        requestedServerName = String(req.query.name).trim();
    }
    res.sendStatus(30000);
});

app.get('/app/submit-download', (req, res) => {
    if (req.query.name) {
        requestedDownloadMethod = String(req.query.name).trim();
    }
    res.sendStatus(30000);
});

// RAW PLAIN TEXT POLL GATEWAYS READ BY THE C# APPLICATION LOOP
app.get('/map/check', (req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    if (requestedMapName) {
        const val = requestedMapName;
        requestedMapName = ""; 
        return res.send(val);
    }
    res.send("");
});

app.get('/server/check', (req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    if (requestedServerName) {
        const val = requestedServerName;
        requestedServerName = ""; 
        return res.send(val);
    }
    res.send("");
});

app.get('/app/check', (req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    if (requestedDownloadMethod) {
        const val = requestedDownloadMethod;
        requestedDownloadMethod = ""; 
        return res.send(val);
    }
    res.send("");
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Server 2 (Secondary) running on port ${PORT}`);
});
