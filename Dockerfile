# Turnstile - Self-hosted download provider bridge
# Part of the Pageturner project: https://github.com/pageturner-app/turnstile
# Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 7878

CMD ["node", "index.js"]
