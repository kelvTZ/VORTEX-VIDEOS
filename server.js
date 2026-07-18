const express = require('express');
const cors = require('cors');
const path = require('path');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const YT_DLP_PATH = path.join(__dirname, 'yt-dlp.exe');
const FFMPEG_DIR = path.join(__dirname, 'ffmpeg');
const FFMPEG_PATH = path.join(FFMPEG_DIR, 'ffmpeg.exe');
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const LOGO_DIR = path.join(__dirname, 'logos');
const GALLERY_FILE = path.join(__dirname, 'gallery.json');

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
if (!fs.existsSync(LOGO_DIR)) fs.mkdirSync(LOGO_DIR, { recursive: true });

// Configurar multer para uploads de logos
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, LOGO_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${crypto.randomUUID()}${ext}`);
    }
});
const upload = multer({ storage });

// Rota de upload de logo
app.post('/api/logo/upload', upload.single('logo'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    res.json({ filename: req.file.filename, url: `/logos/${req.file.filename}` });
});
app.use('/logos', express.static(LOGO_DIR));

// ==================== GALERIA ====================
function loadGallery() {
    try {
        if (fs.existsSync(GALLERY_FILE)) {
            return JSON.parse(fs.readFileSync(GALLERY_FILE, 'utf-8'));
        }
    } catch (e) {}
    return [];
}

function saveGallery(gallery) {
    fs.writeFileSync(GALLERY_FILE, JSON.stringify(gallery, null, 2), 'utf-8');
}

const activeDownloads = new Map();

function detectPlatform(url) {
    if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
    if (/tiktok\.com/i.test(url)) return 'tiktok';
    if (/instagram\.com/i.test(url)) return 'instagram';
    return 'other';
}

function getCommonArgs(url) {
    const args = [
        '--no-warnings',
        '--no-check-certificates',
        '--socket-timeout', '15',
        '--retries', '3',
        '--cookies-from-browser', 'chrome',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    ];
    if (fs.existsSync(FFMPEG_DIR)) {
        args.push('--ffmpeg-location', FFMPEG_DIR);
    }
    return args;
}

app.get('/api/info', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'A URL do vídeo é obrigatória.' });
    const platform = detectPlatform(videoUrl);

    try {
        // Tentar obter informações primeiro com cookies do Chrome
        let args = [...getCommonArgs(videoUrl), '--dump-json', '--no-playlist', videoUrl];
        
        execFile(YT_DLP_PATH, args, { maxBuffer: 1024 * 1024 * 10, timeout: 45000 }, (error, stdout, stderr) => {
            if (error) {
                console.warn('Falha na busca com cookies do Chrome. Tentando sem cookies...');
                // Fallback: Tenta sem cookies ou com outros navegadores se falhar
                const fallbackArgs = [
                    '--no-warnings',
                    '--no-check-certificates',
                    '--socket-timeout', '15',
                    '--retries', '3',
                    '--no-cache-dir',
                    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    '--dump-json',
                    '--no-playlist',
                    videoUrl
                ];
                if (fs.existsSync(FFMPEG_DIR)) {
                    fallbackArgs.push('--ffmpeg-location', FFMPEG_DIR);
                }

                execFile(YT_DLP_PATH, fallbackArgs, { maxBuffer: 1024 * 1024 * 10, timeout: 45000 }, (fallbackError, fallbackStdout, fallbackStderr) => {
                    if (fallbackError) {
                        console.error('Erro geral yt-dlp:', fallbackStderr || fallbackError.message);
                        return res.status(500).json({ error: 'Erro ao processar o vídeo. Verifique o link ou tente mais tarde.' });
                    }
                    processarResultado(fallbackStdout);
                });
                return;
            }
            processarResultado(stdout);
        });

        function processarResultado(stdoutData) {
            try {
                const info = JSON.parse(stdoutData);
                const maxHeight = info.formats
                    ? Math.max(...info.formats.filter(f => f.height).map(f => f.height), 0)
                    : 720;

                let formats = [];
                if (platform === 'youtube') {
                    const presets = [
                        { id: 'best_4k', label: '4K (2160p) - Melhor Qualidade 🏆', format: 'bestvideo[height<=2160]+bestaudio/best[height<=2160]', minHeight: 2160 },
                        { id: 'best_1440', label: '1440p (2K) - Qualidade Alta', format: 'bestvideo[height<=1440]+bestaudio/best[height<=1440]', minHeight: 1440 },
                        { id: 'best_1080', label: '1080p (Full HD) - Recomendado ⭐', format: 'bestvideo[height<=1080]+bestaudio/best[height<=1080]', minHeight: 1080 },
                        { id: 'best_720', label: '720p (HD)', format: 'bestvideo[height<=720]+bestaudio/best[height<=720]', minHeight: 720 },
                        { id: 'best_480', label: '480p (SD)', format: 'bestvideo[height<=480]+bestaudio/best[height<=480]', minHeight: 480 },
                        { id: 'best_360', label: '360p (Baixa)', format: 'bestvideo[height<=360]+bestaudio/best[height<=360]', minHeight: 360 }
                    ];
                    formats = presets.filter(p => p.minHeight <= maxHeight)
                        .map(p => ({ id: p.id, label: p.label, format: p.format }));
                } else {
                    formats.push({ id: 'best', label: `Melhor Qualidade Disponível (${maxHeight}p) ⭐`, format: 'best' });
                    if (info.formats && info.formats.length > 0) {
                        const seen = new Set();
                        info.formats
                            .filter(f => f.height && f.url)
                            .sort((a, b) => (b.height || 0) - (a.height || 0))
                            .forEach(f => {
                                const key = f.height + 'p';
                                if (!seen.has(key) && seen.size < 5) {
                                    seen.add(key);
                                    formats.push({ id: `fmt_${f.format_id}`, label: `${f.height}p (.${f.ext || 'mp4'})`, format: f.format_id });
                                }
                            });
                    }
                }
                // Sempre adicionar apenas áudio
                formats.push({ id: 'audio_best', label: '🎵 Apenas Áudio (MP3)', format: 'bestaudio' });

                res.json({
                    title: info.title || info.description?.substring(0, 60) || 'Sem Título',
                    thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails.length > 0 ? info.thumbnails[info.thumbnails.length - 1].url : ''),
                    duration: info.duration || 0,
                    author: info.uploader || info.channel || info.creator || 'Desconhecido',
                    platform,
                    formats
                });
            } catch (parseError) {
                res.status(500).json({ error: 'Erro ao interpretar informações.' });
            }
        }
    } catch (err) {
        res.status(500).json({ error: 'Erro interno.' });
    }
});

// ==================== ROTAS: INICIAR DOWNLOAD ====================
app.post('/api/download/start', (req, res) => {
    const { url, format: formatStr, title, thumbnail, duration, author, trim, resize } = req.body;

    if (!url || !formatStr) return res.status(400).json({ error: 'URL e formato são obrigatórios.' });

    const downloadId = crypto.randomUUID();
    const isAudio = formatStr === 'bestaudio';

    activeDownloads.set(downloadId, {
        status: 'starting',
        progress: 0,
        speed: '',
        eta: '',
        size: '',
        title: title || 'Vídeo',
        thumbnail: thumbnail || '',
        duration: duration || 0,
        author: author || '',
        filePath: null,
        fileName: null,
        error: null
    });

    res.json({ downloadId });

    const safeTitle = (title || 'video')
        .replace(/[^a-zA-Z0-9\s\-_]/g, '')
        .replace(/\s+/g, ' ')
        .substring(0, 80) || 'video';

    const ext = isAudio ? 'mp3' : 'mp4';
    const outputTemplate = path.join(DOWNLOADS_DIR, `${safeTitle}.%(ext)s`);

    const args = [...getCommonArgs(url)];
    args.push(
        '-f', formatStr,
        '--merge-output-format', ext,
        '-o', outputTemplate,
        '--no-playlist',
        '--newline',
        '--no-embed-metadata',
        '--no-embed-info-json',
        '--no-embed-chapters',
        '--no-embed-subs',
        '--concurrent-fragments', '8',
        '--buffer-size', '4096K',
        '--http-chunk-size', '10M',
        '--postprocessor-args', 'ffmpeg:-map_metadata -1',
        url
    );

    if (isAudio) {
        const mergeIdx = args.indexOf('--merge-output-format');
        args.splice(mergeIdx, 2);
        args.push('--extract-audio', '--audio-format', 'mp3');
    }

    console.log(`[${downloadId}] Iniciando download yt-dlp: ${safeTitle}`);
    const proc = spawn(YT_DLP_PATH, args);
    let stderrData = '';

    const updateProgress = (line) => {
        const dl = activeDownloads.get(downloadId);
        if (!dl) return;
        const progressMatch = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\S+)\s+at\s+([\d.]+\S+)\s+ETA\s+(\S+)/);
        if (progressMatch) {
            dl.status = 'downloading';
            dl.progress = parseFloat(progressMatch[1]) * 0.9; // Deixa 10% para o processo de watermark se houver
            dl.size = progressMatch[2];
            dl.speed = progressMatch[3];
            dl.eta = progressMatch[4];
        }
        if (line.includes('[Merger]') || line.includes('[ExtractAudio]')) {
            dl.status = 'processing';
        }
    };

    proc.stdout.on('data', data => data.toString().split('\n').forEach(updateProgress));
    proc.stderr.on('data', data => {
        stderrData += data.toString();
        data.toString().split('\n').forEach(updateProgress);
    });

    proc.on('close', (code) => {
        const dl = activeDownloads.get(downloadId);
        if (!dl) return;

        if (code !== 0) {
            dl.status = 'error';
            dl.error = stderrData || 'Erro no download do yt-dlp.';
            return;
        }

        // Encontrar arquivo baixado
        const possibleFiles = fs.readdirSync(DOWNLOADS_DIR)
            .filter(f => f.startsWith(safeTitle.substring(0, 30)))
            .map(f => ({ name: f, path: path.join(DOWNLOADS_DIR, f), time: fs.statSync(path.join(DOWNLOADS_DIR, f)).mtimeMs }))
            .sort((a, b) => b.time - a.time);

        if (possibleFiles.length === 0) {
            dl.status = 'error';
            dl.error = 'Arquivo não encontrado após download.';
            return;
        }

        const file = possibleFiles[0];

        // Processamento pós-download via FFmpeg se for vídeo e tiver filtros de corte ou redimensionamento
        if (!isAudio && fs.existsSync(FFMPEG_PATH)) {
            const hasTrim = !!trim;
            const hasResize = resize === 'shorts';

            if (hasTrim || hasResize) {
                dl.status = 'processing';
                const tempOutputFile = path.join(DOWNLOADS_DIR, `proc_${file.name}`);
                
                const ffmpegArgs = ['-y'];

                // 1. Aplicar corte de tempo no início
                if (hasTrim) {
                    ffmpegArgs.push('-ss', String(trim.start), '-to', String(trim.end));
                }

                ffmpegArgs.push('-i', file.path);

                // 2. Aplicar crop Shorts (Vertical 9:16) no centro
                if (hasResize) {
                    ffmpegArgs.push('-vf', 'crop=ih*9/16:ih');
                }

                // Mapear áudio original
                ffmpegArgs.push('-map', '0:a?');
                
                // Configurar encoders rápidos e compatíveis com celular (yuv420p é obrigatório para rodar em qualquer smartphone)
                ffmpegArgs.push('-c:v', 'libx264', '-profile:v', 'main', '-level:v', '4.0', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-c:a', 'aac', tempOutputFile);

                console.log(`[${downloadId}] Executando FFmpeg pós-processamento: ${ffmpegArgs.join(' ')}`);
                const ffmpegProc = spawn(FFMPEG_PATH, ffmpegArgs);

                ffmpegProc.on('close', (codeProc) => {
                    if (codeProc === 0 && fs.existsSync(tempOutputFile)) {
                        try {
                            fs.unlinkSync(file.path);
                            fs.renameSync(tempOutputFile, file.path);
                        } catch (e) {
                            console.error("Erro ao substituir arquivo processado:", e);
                        }
                    }
                    concluirDownload(downloadId, file, title, safeTitle, formatStr, isAudio);
                });
                return;
            }
        }

        concluirDownload(downloadId, file, title, safeTitle, formatStr, isAudio);
    });
});

function concluirDownload(downloadId, file, title, safeTitle, formatStr, isAudio) {
    const dl = activeDownloads.get(downloadId);
    if (!dl) return;

    dl.status = 'done';
    dl.progress = 100;
    dl.filePath = file.path;
    dl.fileName = file.name;

    const gallery = loadGallery();
    const fileSize = fs.statSync(file.path).size;
    gallery.unshift({
        fileName: file.name,
        title: title || safeTitle,
        thumbnail: dl.thumbnail,
        author: dl.author,
        duration: dl.duration,
        quality: formatStr,
        size: fileSize,
        date: new Date().toISOString(),
        isAudio
    });
    saveGallery(gallery);
    console.log(`[${downloadId}] Concluído com sucesso.`);
}

app.get('/api/download/progress/:id', (req, res) => {
    const downloadId = req.params.id;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const interval = setInterval(() => {
        const dl = activeDownloads.get(downloadId);
        if (!dl) {
            res.write(`data: ${JSON.stringify({ status: 'not_found' })}\n\n`);
            clearInterval(interval);
            res.end();
            return;
        }

        res.write(`data: ${JSON.stringify({
            status: dl.status,
            progress: dl.progress,
            speed: dl.speed,
            eta: dl.eta,
            size: dl.size,
            error: dl.error,
            fileName: dl.fileName
        })}\n\n`);

        if (dl.status === 'done' || dl.status === 'error') {
            clearInterval(interval);
            res.end();
            setTimeout(() => activeDownloads.delete(downloadId), 30000);
        }
    }, 500);

    req.on('close', () => clearInterval(interval));
});

app.get('/api/download/file/:fileName', (req, res) => {
    const fileName = req.params.fileName;
    const filePath = path.join(DOWNLOADS_DIR, fileName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Arquivo não encontrado.' });
    const asciiName = fileName.replace(/[^a-zA-Z0-9_\-.\s]/g, '') || 'video.mp4';
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"`);
    const ext = path.extname(fileName).slice(1);
    res.setHeader('Content-Type', ext === 'mp3' ? 'audio/mpeg' : 'video/mp4');
    fs.createReadStream(filePath).pipe(res);
});

app.get('/api/gallery', (req, res) => {
    const gallery = loadGallery();
    const validGallery = gallery.filter(item => fs.existsSync(path.join(DOWNLOADS_DIR, item.fileName)));
    if (validGallery.length !== gallery.length) saveGallery(validGallery);
    res.json(validGallery);
});

app.delete('/api/gallery/:index', (req, res) => {
    const index = parseInt(req.params.index, 10);
    const gallery = loadGallery();
    if (index < 0 || index >= gallery.length) return res.status(400).json({ error: 'Índice inválido.' });

    const item = gallery[index];
    const filePath = path.join(DOWNLOADS_DIR, item.fileName);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
    gallery.splice(index, 1);
    saveGallery(gallery);
    res.json({ success: true });
});

app.get('/api/gallery/play/:fileName', (req, res) => {
    const fileName = req.params.fileName;
    const filePath = path.join(DOWNLOADS_DIR, fileName);
    if (!fs.existsSync(filePath)) return res.status(404).send('Arquivo não encontrado.');
    const stat = fs.statSync(filePath);
    const ext = path.extname(fileName).slice(1);
    const contentType = ext === 'mp3' ? 'audio/mpeg' : 'video/mp4';

    const range = req.headers.range;
    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const chunkSize = (end - start) + 1;
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': contentType
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
        res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': contentType });
        fs.createReadStream(filePath).pipe(res);
    }
});

process.on('uncaughtException', (err) => console.error('Erro uncaught:', err.message));
process.on('unhandledRejection', (reason) => console.error('Rejection:', reason));

// --- PORTA 8080: Servidor do VORTEX Downloader ---
const PORT = 8080;
app.listen(PORT, () => {
    console.log(`🚀 VORTEX Downloader rodando em http://localhost:${PORT}`);
});
