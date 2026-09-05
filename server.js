const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const GEMINI_API_KEY = process.env.OPENAI_API_KEY; // 렌더에 넣은 구글 키

const SCENARIO = {
    character: "지능형 연쇄살인마 '스마일'",
    prompt: `[알리바이]: "어젯밤 11시, 나는 방에서 혼자 웃음소리가 가득한 코미디 영화를 크게 틀어놓고 보고 있었다."
    [치명적 모순]: 이웃은 "어젯밤 11시에 그 방에서 심하게 다투는 남녀의 목소리와 비명 소리를 들었다"고 증언했습니다.
    [데미지 키워드]: 이웃의 증언, 남녀의 다툼, 비명소리`
};

const roomData = {};

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ roomId, playerName }) => {
        socket.join(roomId);
        if (!roomData[roomId]) {
            roomData[roomId] = { targetShield: 100, playerSanity: 100, phase: 1, history: [] };
        }
        io.to(roomId).emit('systemMessage', `[SYSTEM] ${playerName} 요원 접속. 타겟의 멘탈 반격에 주의하십시오.`);
        socket.emit('roomState', roomData[roomId]);
    });

    socket.on('interrogate', async ({ roomId, playerName, message }) => {
        const room = roomData[roomId];
        if (!room || room.phase === 2) return;

        io.to(roomId).emit('playerMessage', { playerName, message });
        io.to(roomId).emit('aiTyping', true);

        const systemPrompt = `
        당신은 ${SCENARIO.character}입니다. 방어막: ${room.targetShield}%. 플레이어 멘탈: ${room.playerSanity}%.
        ${SCENARIO.prompt}
        [전투 규칙]
        1. 모순(비명, 다툼 등)을 정확히 찌르면 'target_damage (20~40)'를 주고 오열하거나 당황하세요.
        2. 엉뚱한 질문이면 플레이어를 잔인하게 조롱하고 'player_damage (15~30)'를 주세요.
        3. 방어막이 0 이하가 되면 is_broken: true를 반환하세요.
        반드시 JSON 형식으로만 응답하세요: { "reply": "대사", "target_damage": 0~50, "player_damage": 0~50, "is_broken": false }`;

        try {
            // 구글 Gemini 공식 REST API 직접 호출 (패키지 에러 원천 차단)
            let contents = [{ role: 'user', parts: [{ text: systemPrompt + "\n\n[대화 시작]" }] }];
            for (let h of room.history) {
                contents.push({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.content }] });
            }
            contents.push({ role: 'user', parts: [{ text: message }] });

            const apiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: contents,
                    generationConfig: { responseMimeType: 'application/json' }
                })
            });

            const jsonRes = await apiResponse.json();
            const textResult = jsonRes.candidates[0].content.parts[0].text;
            const data = JSON.parse(textResult);
            
            room.history.push({ role: "user", content: message }, { role: "assistant", content: data.reply });
            room.targetShield = Math.max(0, room.targetShield - (data.target_damage || 0));
            room.playerSanity = Math.max(0, room.playerSanity - (data.player_damage || 0));
            if (data.is_broken || room.targetShield <= 0) room.phase = 2;

            io.to(roomId).emit('aiTyping', false);
            io.to(roomId).emit('aiResponse', { 
                reply: data.reply, targetShield: room.targetShield, playerSanity: room.playerSanity, 
                target_damage: data.target_damage || 0, player_damage: data.player_damage || 0, phase: room.phase 
            });
        } catch (e) {
            console.error(e);
            io.to(roomId).emit('systemMessage', "[ERROR] 타겟이 통신을 교란합니다.");
            io.to(roomId).emit('aiTyping', false);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SYNDROME SERVER ACTIVE ON PORT ${PORT}`));