require('dotenv').config();
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const os = require('os');
const PORT = process.env.PORT || 9999;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';

function getLanIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}
const DB_PATH = path.join(__dirname, 'data', 'db.json');
const UNIV_CSV = path.join(__dirname, 'data', '한국대학교육협의회_대학알리미 대학별 학과정보_20230614.csv');
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

// ─── 대학 CSV 파싱 (서버 시작 시 1회) ──────────────────────────────────────────
// 컬럼: 조사년도,대학구분,학교구분,지역,설립구분,학교명,본분교명,단과대학명,
//        학부_과(전공)명,주야구분,학과특성,학과상태,표준분류대계열,표준분류중계열,
//        표준분류소계열,대학자체대계열,수업연한,학위과정

// major → [대학명, ...] (중복 없음)
const majorToUnivs = new Map();
// 대학명 → [학과명, ...] (중복 없음)
const univToMajors = new Map();
// major → { 대계열, 중계열, 소계열 }
const majorToCategory = new Map();

function parseCSVLine(line) {
  const cols = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  cols.push(cur.trim());
  return cols;
}

function loadUnivCSV() {
  let text;
  try {
    const buf = fs.readFileSync(UNIV_CSV);
    // UTF-8 BOM 제거 후 디코딩
    text = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF
      ? buf.slice(3).toString('utf-8')
      : buf.toString('utf-8');
  } catch (e) {
    console.warn('⚠️  대학 CSV 로딩 실패:', e.message);
    return;
  }

  const lines = text.split('\n');
  let count = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const c = parseCSVLine(line);
    if (c.length < 18) continue;

    const univType    = c[1];  // 대학구분: 대학, 대학원, 전문대학
    const region      = c[3];  // 지역
    const univName    = c[5];  // 학교명
    const campus      = c[6];  // 본분교명: 본교, 분교
    const deptName    = c[8];  // 학부_과(전공)명
    const dayNight    = c[9];  // 주야구분: 주간, 야간
    const deptStatus  = c[11]; // 학과상태: 기존, 폐지
    const cat1        = c[12]; // 표준분류대계열
    const cat2        = c[13]; // 표준분류중계열
    const cat3        = c[14]; // 표준분류소계열
    const degree      = c[17]; // 학위과정: 학사, 석사, 박사

    // 4년제 본교, 주간, 현존 학과, 학사과정만
    if (univType !== '대학') continue;
    if (campus !== '본교') continue;
    if (dayNight !== '주간') continue;
    if (deptStatus !== '기존') continue;
    if (degree !== '학사') continue;
    if (!deptName || !univName) continue;

    if (!majorToUnivs.has(deptName)) majorToUnivs.set(deptName, new Set());
    majorToUnivs.get(deptName).add(univName);

    if (!univToMajors.has(univName)) univToMajors.set(univName, new Set());
    univToMajors.get(univName).add(deptName);

    if (!majorToCategory.has(deptName)) {
      majorToCategory.set(deptName, { 대계열: cat1, 중계열: cat2, 소계열: cat3 });
    }
    count++;
  }

  console.log(`✓ 대학 CSV 파싱 완료: ${count.toLocaleString()}개 학과 데이터, ${majorToUnivs.size.toLocaleString()}개 학과명, ${univToMajors.size.toLocaleString()}개 대학`);
}

// 서버 시작 시 로드
loadUnivCSV();

// 학과명으로 대학 목록 조회 (최대 N개, 가나다 정렬)
function getUnivsByMajor(majorName, limit = 50) {
  const set = majorToUnivs.get(majorName);
  if (!set) return [];
  return [...set].sort((a, b) => a.localeCompare(b, 'ko')).slice(0, limit);
}

// 학과명 검색 (부분 일치)
function searchMajors(q, limit = 20) {
  const results = [];
  for (const [name, univSet] of majorToUnivs) {
    if (name.includes(q)) {
      const cat = majorToCategory.get(name) || {};
      results.push({ name, univCount: univSet.size, ...cat });
    }
  }
  return results
    .sort((a, b) => b.univCount - a.univCount)
    .slice(0, limit);
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  } catch (e) {
    return { students: [], teachers: [] };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── Body reader ─────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ─── Claude proxy ────────────────────────────────────────────────────────────

function claudeProxy(body, res) {
  if (!API_KEY) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set in .env' }));
    return;
  }
  const payload = Buffer.from(JSON.stringify(body));
  const opts = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': payload.length,
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
  };
  const req = https.request(opts, (apiRes) => {
    const chunks = [];
    apiRes.on('data', c => chunks.push(c));
    apiRes.on('end', () => {
      res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(Buffer.concat(chunks));
    });
  });
  req.on('error', (e) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  });
  req.write(payload);
  req.end();
}

// ─── AI Curriculum generator ─────────────────────────────────────────────────

const COURSE_CATALOG = {
  '고2': [
    '화법과 언어','독서와 작문','주제 탐구 독서','문학과 영상',
    '대수','미적분 I','확률과 통계','미적분',
    '영어 I','영어 II','영어 독해와 작문',
    '물리학','화학','생명과학','지구과학',
    '물리학 II','화학 II','생명과학 II','지구과학 II',
    '한국지리 탐구','세계지리와 여행','역사로 탐구하는 현대 세계',
    '사회와 문화','윤리와 사상','경제','정치','법과 사회',
    '음악','미술','체육 1','보건','심리학'
  ],
  '고3': [
    '심화 국어','심화 수학 I','심화 수학 II','기하','미적분 II',
    '심화 영어','심화 영어 독해 I',
    '과학의 역사와 문화','생활과 과학','융합과학 탐구',
    '기후변화와 환경생태','사회문제 탐구','인문학과 윤리',
    '논리와 사고','보건','심리학','진로와 직업','인공지능 기초'
  ]
};

function buildCurriculumPrompt(student) {
  // 희망 학과로 실제 개설 대학 조회
  const major = student.major || '';
  const univList = major ? getUnivsByMajor(major, 20) : [];
  const univSection = univList.length > 0
    ? `\n【실제 ${major} 개설 대학 (전국 ${(majorToUnivs.get(major) || new Set()).size}개)】\n${univList.slice(0, 10).join(', ')} 외 ${Math.max(0, univList.length - 10)}개`
    : '';

  // 관련 학과 검색 (키워드 기반)
  const relatedMajors = major
    ? searchMajors(major.slice(0, 2), 8).map(m => `${m.name}(${m.univCount}개 대학)`).join(', ')
    : '';
  const relatedSection = relatedMajors
    ? `\n【유사 학과 (실제 데이터)】\n${relatedMajors}`
    : '';

  return `당신은 한국 고등학교 진로 전문 AI입니다.
학생 정보를 바탕으로 맞춤형 교과 커리큘럼과 비교과 활동을 추천해주세요.

【학생 정보】
- 현재 학년: 고2
- 희망 직업: ${student.career || '미입력'}
- 희망 학과: ${student.major || '미입력'}
- 관심사: ${(student.interests || []).join(', ') || '미입력'}
- 좋아하는 과목: ${(student.favs || []).join(', ') || '미입력'}
- 기존 활동: ${student.activities || '미입력'}
${univSection}${relatedSection}

【고2 선택 가능 과목 목록 (이 목록에서만 추천)】
${COURSE_CATALOG['고2'].join(', ')}

【고3 선택 가능 과목 목록 (이 목록에서만 추천)】
${COURSE_CATALOG['고3'].join(', ')}

반드시 아래 JSON 형식으로만 답하세요 (코드블록, 설명 없이 순수 JSON):
{
  "grades": {
    "고2": [
      {"name": "과목명(위 목록에서 정확히)", "type": "일반선택|진로선택|융합선택|교양|공통", "status": "recommended|optional|required", "credit": 4, "reason": "추천 이유 1문장"}
    ],
    "고3": [
      {"name": "과목명(위 목록에서 정확히)", "type": "진로선택|융합선택|교양", "status": "recommended|optional", "credit": 3, "reason": "추천 이유 1문장"}
    ]
  },
  "activities": [
    {"id": "a1", "category": "탐구", "title": "활동 제목", "why": "추천 이유", "duration": "8주", "output": "결과물", "status": "new"},
    {"id": "a2", "category": "독서", "title": "활동 제목", "why": "추천 이유", "duration": "4주", "output": "결과물", "status": "new"},
    {"id": "a3", "category": "동아리", "title": "활동 제목", "why": "추천 이유", "duration": "학기 단위", "output": "결과물", "status": "new"},
    {"id": "a4", "category": "체험", "title": "활동 제목", "why": "추천 이유", "duration": "1일", "output": "결과물", "status": "new"},
    {"id": "a5", "category": "봉사", "title": "활동 제목", "why": "추천 이유", "duration": "연간", "output": "결과물", "status": "new"}
  ],
  "majorCandidates": [
    {"name": "학과명", "fit": 90, "why": "적합 이유 1문장", "keyCourses": ["과목1", "과목2"], "univCount": 숫자},
    {"name": "학과명2", "fit": 75, "why": "적합 이유 1문장", "keyCourses": ["과목1"], "univCount": 숫자}
  ]
}`;
}

async function generateCurriculum(student, res) {
  if (!API_KEY) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set in .env' }));
    return;
  }
  const prompt = buildCurriculumPrompt(student);
  const payload = Buffer.from(JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }]
  }));
  const opts = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': payload.length,
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
  };
  const apiReq = https.request(opts, (apiRes) => {
    const chunks = [];
    apiRes.on('data', c => chunks.push(c));
    apiRes.on('end', () => {
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString());
        const text = (data.content && data.content[0] && data.content[0].text) || '';
        const match = text.match(/\{[\s\S]+\}/);
        if (!match) throw new Error('JSON not found in response');
        const parsed = JSON.parse(match[0]);

        // majorCandidates에 실제 대학 목록 보강
        if (parsed.majorCandidates) {
          parsed.majorCandidates = parsed.majorCandidates.map(mc => {
            const univs = getUnivsByMajor(mc.name, 10);
            const count = (majorToUnivs.get(mc.name) || new Set()).size;
            return { ...mc, schools: univs, univCount: count || mc.univCount };
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(parsed));
      } catch (e) {
        console.error('Curriculum parse error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'AI 응답 파싱 실패: ' + e.message }));
      }
    });
  });
  apiReq.on('error', (e) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  });
  apiReq.write(payload);
  apiReq.end();
}

// ─── Main request handler ─────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];
  const query = Object.fromEntries(new URLSearchParams(req.url.split('?')[1] || ''));
  const method = req.method.toUpperCase();

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // ── API routes ──────────────────────────────────────────────────────────────

  // Claude proxy
  if (pathname === '/api/claude' && method === 'POST') {
    const body = await readBody(req);
    claudeProxy(body, res);
    return;
  }

  // AI curriculum generation
  if (pathname === '/api/ai/curriculum' && method === 'POST') {
    const body = await readBody(req);
    await generateCurriculum(body, res);
    return;
  }

  // 대학 조회: ?major=의예과  →  해당 학과 개설 대학 목록
  // 대학 조회: ?q=의학        →  학과명 검색
  if (pathname === '/api/universities' && method === 'GET') {
    if (query.major) {
      const univs = getUnivsByMajor(query.major);
      const count = (majorToUnivs.get(query.major) || new Set()).size;
      const cat = majorToCategory.get(query.major) || {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ major: query.major, totalCount: count, universities: univs, ...cat }));
    } else if (query.q) {
      const majors = searchMajors(query.q);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ query: query.q, results: majors }));
    } else {
      // 전체 통계
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        totalMajors: majorToUnivs.size,
        totalUnivs: univToMajors.size,
      }));
    }
    return;
  }

  // Students list
  if (pathname === '/api/students' && method === 'GET') {
    const db = readDB();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(db.students));
    return;
  }

  // Add student
  if (pathname === '/api/students' && method === 'POST') {
    const body = await readBody(req);
    if (!body.name || !body.id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'name and id required' }));
      return;
    }
    const db = readDB();
    const exists = db.students.find(s => s.id === body.id);
    if (exists) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '이미 존재하는 학생 ID입니다' }));
      return;
    }
    const newStudent = {
      id: body.id,
      role: '학생',
      name: body.name,
      school: body.school || '한빛고 2학년 4반',
      initial: body.name[0] || '학',
      createdAt: new Date().toISOString(),
    };
    db.students.push(newStudent);
    writeDB(db);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(newStudent));
    return;
  }

  // Save student curriculum data
  if (pathname.startsWith('/api/students/') && pathname.endsWith('/curriculum') && method === 'POST') {
    const studentId = pathname.split('/')[3];
    const body = await readBody(req);
    const db = readDB();
    const student = db.students.find(s => s.id === studentId);
    if (!student) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '학생을 찾을 수 없습니다' }));
      return;
    }
    student.curriculumData = body;
    student.updatedAt = new Date().toISOString();
    writeDB(db);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Static files ─────────────────────────────────────────────────────────────

  let urlPath = pathname;
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, urlPath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found: ' + urlPath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    // index.html 서빙 시 app.js 버전을 파일 mtime 기반으로 자동 교체
    if (urlPath === '/index.html') {
      try {
        const appMtime = fs.statSync(path.join(ROOT, 'app.js')).mtimeMs;
        const ver = Math.floor(appMtime / 1000).toString(36);
        const html = data.toString('utf-8').replace(/app\.js\?v=[^"']+/, 'app.js?v=' + ver);
        res.end(Buffer.from(html, 'utf-8'));
        return;
      } catch(e) { /* fallthrough */ }
    }
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  if (!API_KEY) {
    console.warn('\x1b[33m⚠️  ANTHROPIC_API_KEY가 설정되지 않았습니다.\x1b[0m');
    console.warn('   .env.example을 복사해 .env 파일을 만들고 API 키를 입력하세요.\n');
  }
  console.log(`\x1b[32m✓ 서버 실행 중\x1b[0m`);
  console.log(`  이 PC:       http://localhost:${PORT}`);
  const ips = getLanIPs();
  if (ips.length > 0) {
    ips.forEach(ip => console.log(`  같은 Wi-Fi:  http://${ip}:${PORT}`));
  }
  console.log(`\n  교사 로그인: teacher / 학생 로그인: minseo, seoyon, jihun ...`);
  console.log(`\n  인터넷 터널: start-tunnel.bat 실행 후 표시된 URL 사용\n`);
});
