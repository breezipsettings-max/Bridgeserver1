-- [[ BLEACH-OS BRIDGE MODIFIED ]]
local HttpService = game:GetService("HttpService")
local bridgeURL = "wss://your-project-name.onrender.com" -- CHANGE THIS TO YOUR URL
local ws = WebSocket.connect(bridgeURL)

-- (Keep your original variables/functions here: alignToHead, lp, etc.)

-- 3. GLOBAL SYNC LISTENER (Receives from other servers)
ws.OnMessage:Connect(function(msg)
    local data = HttpService:JSONDecode(msg)
    
    if data.keyword == "DevHatSync" then
        local senderName = data.sender
        local hatName = data.hatName
        local senderPlayer = Players:FindFirstChild(senderName)
        
        if senderPlayer and senderPlayer ~= lp and senderPlayer.Character then
            local targetHat = devHats:FindFirstChild(hatName)
            if targetHat then
                -- Clear old synced hats
                for _, v in pairs(senderPlayer.Character:GetDescendants()) do
                    if v.Name == "AccessoryWeld" then v.Parent.Parent:Destroy() end
                end
                alignToHead(senderPlayer.Character, targetHat:Clone())
            end
        end
    end
end)

-- 6. MANUAL EQUIP (Now sends to the Bridge)
local function manualEquip(hat)
    local char = lp.Character
    if not char or not char:FindFirstChild("Head") then return end
    
    -- BROADCAST to the Bridge
    local syncData = {
        keyword = "DevHatSync",
        sender = lp.Name,
        hatName = hat.Name
    }
    ws:Send(HttpService:JSONEncode(syncData))

    -- ALIGN locally
    alignToHead(char, hat:Clone())
end
