const express  = require('express');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const app    = express();
const PORT   = process.env.PORT   || 3001;
const SECRET = process.env.SECRET || 'TROQUE_ISSO_POR_UMA_SENHA_FORTE';

app.use(cors());
app.use(express.json());

const _files = {};

let _browser = null;
async function getBrowser() {
    if (!_browser || !_browser.isConnected()) {
        _browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        console.log('[bot] browser iniciado');
    }
    return _browser;
}

async function waitCloudflare(page) {
    const t = await page.title();
    if (t.toLowerCase().includes('momento') || t.toLowerCase().includes('moment')) {
        console.log('[bot] aguardando Cloudflare...');
        await page.waitForFunction(
            () => !document.title.toLowerCase().includes('momento') && !document.title.toLowerCase().includes('moment'),
            { timeout: 25000 }
        ).catch(() => {});
        await page.waitForTimeout(1500);
    }
}

function isBinaryFile(buf) {
    const head = buf.toString('utf8', 0, 20).toLowerCase();
    if (head.includes('<!doctype') || head.includes('<html')) return false;
    // EPUB starts with PK (zip), PDF starts with %PDF
    if (buf[0] === 0x50 && buf[1] === 0x4B) return true; // PK = zip/epub
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return true; // %PDF
    return buf.length > 50000; // >50KB is probably not an HTML error page
}

app.use((req, res, next) => {
    if (req.path === '/health' || req.path.startsWith('/file/')) return next();
    if (req.headers['x-secret'] !== SECRET) return res.status(401).json({ error: 'unauthorized' });
    next();
});

app.get('/health', (_, res) => res.json({ ok: true }));

app.get('/file/:id', (req, res) => {
    const entry = _files[req.params.id];
    if (!entry || !fs.existsSync(entry.path)) {
        return res.status(404).json({ error: 'arquivo nao encontrado ou expirado' });
    }
    const ext  = path.extname(entry.filename).toLowerCase();
    const mime = ext === '.epub' ? 'application/epub+zip'
               : ext === '.pdf'  ? 'application/pdf'
               : 'application/octet-stream';
    res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}"`);
    res.setHeader('Content-Type', mime);
    const stream = fs.createReadStream(entry.path);
    stream.pipe(res);
    stream.on('end', () => {
        fs.unlink(entry.path, () => {});
        delete _files[req.params.id];
    });
});

app.post('/download', async (req, res) => {
    const { title, author, bookPageUrl } = req.body;
    if (!title) return res.status(400).json({ error: 'title obrigatorio' });
    console.log(`[bot] buscando: "${title}" | "${author || ''}"`);

    const browser = await getBrowser();
    const ctx = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'pt-BR',
        acceptDownloads: true,
    });
    const page = await ctx.newPage();
    let tempFilePath = null;
    let filename     = null;
    let bookUrl      = bookPageUrl || null;

    try {
        // ── 1. Find book page ─────────────────────────────────────────────────
        if (!bookUrl) {
            const firstWords = title.trim().split(/\s+/).slice(0, 3).join(' ');
            const searchUrl  = `https://oceanofpdf.com/?s=${encodeURIComponent(firstWords)}`;
            console.log('[bot] pesquisando:', searchUrl);

            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await waitCloudflare(page);
            await page.waitForTimeout(1500);

            const allLinks = await page.locator('a[href]').all();
            for (const link of allLinks) {
                const href = await link.getAttribute('href').catch(() => null);
                if (href && href.includes('oceanofpdf.com/authors/') && href.split('/').length >= 6) {
                    bookUrl = href;
                    console.log('[bot] livro encontrado:', bookUrl);
                    break;
                }
            }
            if (!bookUrl) {
                console.log('[bot] livro nao encontrado na busca');
                return res.json({ error: 'livro nao encontrado na busca' });
            }
        } else {
            console.log('[bot] usando URL direta:', bookUrl);
        }

        // ── 2. Open book page ─────────────────────────────────────────────────
        await page.goto(bookUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await waitCloudflare(page);
        await page.waitForTimeout(1500);
        console.log('[bot] pagina do livro:', await page.title());

        // ── 3. Set up binary-response interceptor on all pages ────────────────
        let capturedBuffer = null;
        let capturedFilename = null;

        async function interceptResponses(pg) {
            pg.on('response', async (response) => {
                if (capturedBuffer) return;
                const ct = (response.headers()['content-type'] || '').toLowerCase();
                const url = response.url();
                const isFile = ct.includes('epub') || ct.includes('pdf') ||
                    (ct.includes('octet-stream') && !url.includes('oceanofpdf.com'));
                if (!isFile) return;
                try {
                    const buf = await response.body();
                    if (!isBinaryFile(buf)) return;
                    capturedBuffer = buf;
                    const disp = response.headers()['content-disposition'] || '';
                    capturedFilename = disp.match(/filename="?([^";\n]+)"?/i)?.[1]
                        || url.split('/').pop().split('?')[0]
                        || `livro_${Date.now()}.epub`;
                    console.log(`[bot] binario capturado: ${capturedFilename} (${buf.length} bytes)`);
                } catch (_) {}
            });
        }
        await interceptResponses(page);
        ctx.on('page', pg => interceptResponses(pg));

        // ── 4. Try buttons in priority order ──────────────────────────────────
        const btns = [
            ['form:has(input[value*=".epub"]) input[type="image"], input[type="image"][src*="epub"]', 'EPUB'],
            ['form:has(input[value*=".pdf"]) input[type="image"],  input[type="image"][src*="pdf"]',  'PDF'],
            ['form:last-of-type input[type="image"]',  'ultimo form'],
            ['form:first-of-type input[type="image"]', 'primeiro form'],
        ];

        for (const [sel, label] of btns) {
            if (tempFilePath || capturedBuffer) break;

            const btn = page.locator(sel).first();
            if (!await btn.count()) continue;
            console.log(`[bot] clicando ${label}...`);

            // Race: Playwright download event (fires when Content-Disposition: attachment)
            //       vs binary response interceptor above
            //       vs timeout after 75s (full vetalroots chain takes ~30-60s)
            const downloadRace = ctx.waitForEvent('download', { timeout: 75000 });

            await btn.click({ timeout: 5000 }).catch(() => {});

            const winner = await Promise.race([
                downloadRace.then(d => ({ type: 'download', d })),
                new Promise(resolve => {
                    const t = setInterval(() => {
                        if (capturedBuffer) { clearInterval(t); resolve({ type: 'binary' }); }
                    }, 300);
                    setTimeout(() => { clearInterval(t); resolve({ type: 'timeout' }); }, 75000);
                }),
            ]);

            if (winner.type === 'download') {
                filename     = winner.d.suggestedFilename() || `livro_${Date.now()}.epub`;
                tempFilePath = path.join('/tmp', `${Date.now()}_${filename}`);
                await winner.d.saveAs(tempFilePath);
                const size = fs.statSync(tempFilePath).size;
                console.log(`[bot] download direto: ${filename} (${size} bytes)`);

                // Verify it's actually a binary file
                const buf = fs.readFileSync(tempFilePath);
                if (!isBinaryFile(buf)) {
                    console.log('[bot] arquivo baixado e HTML, descartando');
                    fs.unlinkSync(tempFilePath);
                    tempFilePath = null;
                }
            } else if (winner.type === 'binary' && capturedBuffer) {
                filename     = capturedFilename || `livro_${Date.now()}.epub`;
                tempFilePath = path.join('/tmp', `${Date.now()}_${filename}`);
                fs.writeFileSync(tempFilePath, capturedBuffer);
                console.log(`[bot] binario salvo: ${filename} (${capturedBuffer.length} bytes)`);
            } else {
                console.log(`[bot] ${label}: timeout sem download`);
            }
        }

        if (!tempFilePath) {
            console.log('[bot] nao conseguiu baixar');
            return res.json({ error: 'nao foi possivel baixar o arquivo', bookUrl });
        }

        // ── 5. Register and return URL ─────────────────────────────────────────
        const fileId = Date.now().toString();
        _files[fileId] = { path: tempFilePath, filename };

        setTimeout(() => {
            if (_files[fileId]) { fs.unlink(_files[fileId].path, () => {}); delete _files[fileId]; }
        }, 10 * 60 * 1000);

        const base = process.env.RAILWAY_PUBLIC_DOMAIN
            ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
            : 'https://elivros-bot-production.up.railway.app';

        const serveUrl = `${base}/file/${fileId}`;
        console.log('[bot] sucesso! servindo em:', serveUrl);
        return res.json({ url: serveUrl, filename });

    } catch (err) {
        console.error('[bot] erro:', err.message);
        return res.json({ error: err.message });
    } finally {
        await page.close().catch(() => {});
        await ctx.close().catch(() => {});
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Bot rodando na porta ${PORT}`);
    getBrowser().catch(console.error);
});
