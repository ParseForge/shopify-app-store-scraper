FROM apify/actor-node:22

COPY package*.json ./

RUN npm --quiet set progress=false && npm install --include=dev

COPY . ./

RUN npm run build && npm prune --production && rm -rf src tsconfig.json

CMD npm start --silent
