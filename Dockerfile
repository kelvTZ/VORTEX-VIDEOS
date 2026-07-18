# Usar imagem oficial estável do Node.js
FROM node:20-bullseye-slim

# Instalar dependências necessárias: Python3, FFmpeg e curl
RUN apt-get update && apt-get install -y \
    python3 \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Definir diretório de trabalho
WORKDIR /app

# Copiar arquivos de dependências do Node
COPY package*.json ./

# Instalar pacotes do Node
RUN npm install --production

# Copiar todo o código do projeto
COPY . .

# Baixar a versão mais recente do yt-dlp estável do Linux e torná-lo executável
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /app/yt-dlp && \
    chmod a+rx /app/yt-dlp

# Expôr a porta usada pelo app
EXPOSE 8080

# Comando para iniciar o servidor
CMD ["node", "server.js"]
