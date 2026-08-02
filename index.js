const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const TelegramToken = "8890131325:AAG2SAW8cG1x8yH2U-uyHfPtrmsyNpcvb9w";
const TelegramChatId = "-5308116981";
const PRIMARY_URL = "https://bridgeserver1-ydt4.onrender.com";
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
                    jobId: client.jobId || "N/A"
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
            // Handled in response message block below
        } else if (commandName === "chooseplayer" || commandName === "choose_player") {
            // Handled in response message block below
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
                            jobId: client.jobId || "N/A"
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
                    const sJobId = escapeHTML(String(client.jobId || "N/A"));
                    const nsStatus = client.networkSharing !== false ? "ON" : "OFF";
                    const placeId = "8735521924";
                    const joinUrl = `https://www.roblox.com/home?placeid=${placeId}&jobid=${sJobId}`;
                    
                    listText += `${index + 1}. 👤 ${sName} (ID: <code>${sId}</code>) — 📡 Network Sharing: <b>${nsStatus}</b>\n`;
                    listText += `🔗 <a href="${joinUrl}">Join Server (${sJobId})</a>\n\n`;
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
                                jobId: client.jobId || "N/A",
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
                    responseMessage = `❌ <b>Inspection Error:</b> Player "${escapeHTML(targetQuery)}" was not found in active connections.`;
                } else {
                    const fName = escapeHTML(foundClient.playerName || "Unknown");
                    const fId = escapeHTML(String(foundClient.userId || "N/A"));
                    const fRoom = escapeHTML(String(foundClient.room || "EN"));
                    const fJobId = escapeHTML(String(foundClient.jobId || "N/A"));
                    const fNs = foundClient.networkSharing !== false ? "ON" : "OFF";
                    const placeId = "8735521924";
                    const joinUrl = `https://www.roblox.com/home?placeid=${placeId}&jobid=${fJobId}`;
                    
                    responseMessage = 
                        `🔍 <b>Player Profile Inspection</b>\n` +
                        `👤 <b>Name:</b> ${fName}\n` +
                        `🆔 <b>ID:</b> <code>${fId}</code>\n` +
                        `🏠 <b>Lobby/Room:</b> ${fRoom}\n` +
                        `📡 <b>Network Sharing:</b> <b>${fNs}</b>\n` +
                        `🔗 <a href="${joinUrl}">Join Server (${fJobId})</a>\n` +
                        `💬 <a href="https://t.me/Obsidian_WardenBot?start=reply_${fId}">Click here to Reply to ID ${fId}</a>`;
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
            await sendTelegramNotification(responseMessage, chatId);
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

wss.on('connection', (ws) => {
    ws.room = 'EN';
    ws.playerName = 'Unknown';
    ws.userId = 'N/A';
    ws.role = 'CHAT';
    ws.messageCount = 0;
    ws.networkSharing = true;
    ws.jobId = 'N/A';

    ws.on('message', async (data) => {
        const msgStr = typeof data === 'string' ? data : data.toString();

        if (msgStr.startsWith("JOIN:")) {
            const parts = msgStr.split(":");
            ws.room = parts[1] || 'EN';
            ws.playerName = parts[2] || 'Unknown';
            ws.role = parts[3] || "CHAT"; 
            ws.userId = parts[4] || 'N/A';
            ws.jobId = parts[5] || 'N/A';

            if (ws.userId !== 'N/A' && isBlacklisted(ws.userId)) {
                ws.close();
                return;
            }

            console.log(`${ws.playerName} (ID: ${ws.userId}) [JobId: ${ws.jobId}] joined room on Server 2: [${ws.room}] as ${ws.role}`);
            return;
        }

        try {
            const parsed = JSON.parse(msgStr);
            if (parsed.Type === "NetworkSharingUpdate") {
                ws.networkSharing = !!parsed.Enabled;
                return;
            }
        } catch (e) {
            // Not JSON or other message types
        }

        if (msgStr.includes("AntiKickDetected")) {
            try {
                const packet = JSON.parse(msgStr);
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
