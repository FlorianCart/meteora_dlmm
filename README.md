# Meteora DLMM Trading Bot

Bot TypeScript strict pour scanner les pools DLMM Meteora, scorer les opportunites, ouvrir une position bid/ask via le SDK officiel `@meteora-ag/dlmm`, suivre jusqu'a 10 positions et sortir a 100% lorsque le take-profit net est atteint ou que le stop-loss net est touche.

La documentation d'architecture est dans [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Demarrage

```bash
npm install
cp .env.example .env
npm run web
npm run scan
npm run typecheck
```

Par defaut, le bot ne trade pas. Les transactions d'entree ne partent que si `AUTO_OPEN=true` et `WALLET_PRIVATE_KEY` est renseigne.

Pour un test live avec un petit wallet SOL, le mode par defaut est `ENTRY_SIZING_MODE=wallet-ratio`: le bot calcule la taille de la prochaine position depuis le solde SOL disponible et l'exposition deja ouverte. Les valeurs d'exemple sont des ratios: reserve `10%`, taille cible `25%`, taille minimale `4%`, taille maximale `20%`, exposition totale maximale `70%`. Sur un wallet de `0.5 SOL`, cela donne naturellement environ `0.05 SOL` de reserve, `0.02 SOL` de minimum et `0.1 SOL` de maximum par position, mais ces montants changent si le wallet change. `ENTRY_SOL_ONLY=true` force une entree single-sided sur le cote SOL de la pool, sans supposer que le wallet possede deja le token risque.

Les sorties live utilisent `TAKE_PROFIT_PCT=5` et `STOP_LOSS_PCT=-12` dans `.env.example`. Si tu ecris `STOP_LOSS_PCT=12`, le bot le normalise en `-12`.

La range DLMM est definie par `BID_ASK_RANGE_BINS=69`. En position balancee, cela signifie 69 bins au total autour du bin actif. En `ENTRY_SOL_ONLY=true`, le bot decale la range du cote single-sided pour avoir 69 bins utiles avec le token depose. L'ancien `BID_ASK_HALF_WIDTH_BINS` reste accepte en fallback, mais la config force au minimum 69 bins.

Apres une sortie DLMM, le contrat rend les tokens de la position au wallet. Avec `POST_EXIT_SWAP_TO_SOL=true`, le bot swap automatiquement les tokens non-SOL de la pool vers SOL via Jupiter. Pour balayer manuellement les tokens recuperes d'anciennes positions deja fermees:

```bash
npm run start:sweep-to-sol
```

L'interface paper-trading locale tourne sur `http://localhost:8787` par defaut. Elle utilise de l'argent fictif et ne signe aucune transaction.

## Arborescence

```text
docs/ARCHITECTURE.md
src/config.ts
src/index.ts
src/PositionManager.ts
src/paper/PaperBotEngine.ts
src/paper/PaperStore.ts
src/risk/WalletAllocator.ts
src/types.ts
src/wallet.ts
src/dlmm/MeteoraDlmmClient.ts
src/monitoring/MonitoringLoop.ts
src/scanner/PoolScanner.ts
src/services/DexScreenerApi.ts
src/services/HttpClient.ts
src/services/JupiterTokenApi.ts
src/services/MeteoraDataApi.ts
src/services/RugCheckApi.ts
src/services/RpcService.ts
src/state/PositionStore.ts
src/valuation/PositionValuator.ts
src/utils/decimal.ts
src/utils/logger.ts
src/utils/time.ts
src/web/server.ts
web/index.html
web/styles.css
web/app.js
```

## Sources principales

- Meteora DLMM developer docs: https://docs.meteora.ag/developer-guides/dlmm
- Meteora DLMM Data API: https://docs.meteora.ag/developer-guides/dlmm/api-reference/overview
- Meteora DLMM formulas: https://docs.meteora.ag/core-products/dlmm/formulas
- Jupiter Tokens API: https://dev.jup.ag/docs/tokens
- DexScreener API: https://docs.dexscreener.com/api/reference
- RugCheck Swagger: https://api.rugcheck.xyz/swagger/index.html
