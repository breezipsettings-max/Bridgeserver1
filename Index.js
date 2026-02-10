const WebSocket = require('ws');
const http = require('http');

// Create a simple server for Render health checks
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("Bridge is Active");
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log("A user connected to the Sync Bridge.");

    ws.on('message', (message) => {
        // Broadcast logic: Sends message to EVERYONE except the sender
        wss.clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(message.toString());
            }
        });
    });

    ws.on('close', () => console.log("User disconnected."));
});

server.listen(process.env.PORT || 3000, () => {
    console.log("Relay Bridge Running...");
});
