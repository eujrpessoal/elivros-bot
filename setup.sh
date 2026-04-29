#!/bin/bash
# Cole e rode esse script no servidor Oracle depois de conectar via SSH

set -e
echo "=== Instalando Node.js ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "=== Instalando dependências do sistema para Playwright ==="
sudo apt-get install -y \
    libglib2.0-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libdbus-1-3 libxkbcommon0 libx11-6 libxcomposite1 \
    libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libatspi2.0-0 wget ca-certificates

echo "=== Instalando PM2 (gerenciador de processos) ==="
sudo npm install -g pm2

echo "=== Instalando dependências do bot ==="
npm install

echo "=== Instalando Chromium para Playwright ==="
npx playwright install chromium
npx playwright install-deps chromium

echo "=== Iniciando o bot com PM2 ==="
pm2 start ecosystem.config.js
pm2 save
pm2 startup | tail -1 | sudo bash

echo ""
echo "=== Bot instalado! ==="
echo "Verifique com: pm2 status"
echo "Logs com: pm2 logs elivros-bot"
