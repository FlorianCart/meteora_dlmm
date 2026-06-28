# Architecture du bot Meteora DLMM

## Objectif

Construire un bot DLMM Solana capable de trouver des pools Meteora interessantes, filtrer les risques de rug, ouvrir une position de liquidite bid/ask, suivre jusqu'a 10 positions, puis retirer 100% de la liquidite et claim les fees lorsque le profit net depasse le take-profit configure ou touche le stop-loss.

Sources primaires utilisees:

- Meteora DLMM developer docs: https://docs.meteora.ag/developer-guides/dlmm
- Meteora DLMM Data API: https://docs.meteora.ag/developer-guides/dlmm/api-reference/overview
- Meteora DLMM pool endpoint: https://docs.meteora.ag/api-reference/dlmm/pools/pools
- Meteora DLMM formulas: https://docs.meteora.ag/core-products/dlmm/formulas
- SDK npm `@meteora-ag/dlmm@1.9.10`: https://www.npmjs.com/package/@meteora-ag/dlmm
- DexScreener API: https://docs.dexscreener.com/api/reference
- RugCheck Swagger: https://api.rugcheck.xyz/swagger/index.html

## Modules

```text
PoolScanner
  Meteora Data API + RugCheck + Jupiter + DexScreener
      |
      v
WalletAllocator
  SOL balance + active exposure + reserve/caps
      |
      v
PositionManager
  capacity <= 10, tracked TP/SL state
      |
      +--> MeteoraDlmmClient --> RpcService --> Solana
      |
      +--> PositionStore <--> MonitoringLoop
            JSON atomique     valuation + TP/SL exit trigger
```

### Scanner

`PoolScanner` utilise `GET /pools` sur `https://dlmm.datapi.meteora.ag`, pas fabriq.trade. La Data API Meteora documente une limite de 30 RPS, une pagination 1-based, `page_size`, `sort_by` et `filter_by`. Le scanner ne se limite plus a un seul classement 24h: il fusionne plusieurs profils de sourcing.

Profils:

- mature yield: `fee_tvl_ratio_24h:desc`, avec TVL et volume 24h minimum;
- short-horizon yield: `fee_tvl_ratio_1h:desc` et `fee_tvl_ratio_30m:desc`;
- discovery: `pool_created_at:desc`, avec TVL minimum mais sans volume 24h obligatoire.

Le scanner applique ensuite:

- filtre Meteora: `is_blacklisted=false`, TVL minimum, volume 24h minimum;
- scoring primaire: `fee_tvl_ratio_24h`, `fee_tvl_ratio_1h`, `fee_tvl_ratio_30m`, volume/TVL annualise court terme, TVL, verification des tokens, bin step;
- scoring risque: RugCheck `/v1/tokens/{id}/report/summary` sur token X et token Y;
- scoring confiance: Jupiter Tokens V2 `/search`, `organicScore`, `isVerified`, `audit`, holders, liquidite et volume organique;
- enrichissement DexScreener facultatif: confirmation volume/liquidite off-chain sur les mints.

Une pool recente peut donc passer si elle a:

- age inferieur a `SCANNER_DISCOVERY_MAX_POOL_AGE_HOURS`;
- TVL superieur a `SCANNER_DISCOVERY_MIN_TVL_USD`;
- volume 30m/1h et fee/TVL 30m/1h suffisants;
- controles RugCheck et Jupiter propres.

Elle est rejetee si les fees court terme viennent d'un token suspect. Les fees ne peuvent pas compenser `audit.isSus`, un organic score trop bas, une authority dangereuse ou une concentration holder excessive.

Extensions recommandees:

- Birdeye: ajouter un provider payant pour `token_security`, holders et liquidity concentration quand une cle API est disponible;
- Helius/Geyser: indexer les creations de pools et swaps DLMM en temps reel pour detecter les nouveaux pools avant leur apparition stable dans les APIs publiques;
- on-chain direct: `DLMM.getLbPairs` ou `getProgramAccounts` avec filtres SDK si le RPC autorise `getProgramAccounts`.

### PositionManager

Le gestionnaire refuse d'ouvrir une nouvelle position si le store contient deja `MAX_OPEN_POSITIONS` positions ouvertes ou en sortie. L'etat est persiste dans un JSON ecrit de facon atomique, ce qui suffit pour un bot local. En production multi-process, remplacer par SQLite/Postgres avec verrou par `positionAddress`.

### WalletAllocator

Pour un test live avec un wallet limite, `ENTRY_SIZING_MODE=wallet-ratio` remplace les montants fixes. L'allocator lit le solde SOL du wallet, estime l'exposition deja ouverte via les derniers snapshots ou la valeur d'entree, puis calcule:

```text
wallet_sol              = solde natif du wallet
active_exposure_sol     = positions_ouvertes_usd / prix_SOL_usd
total_capital_sol       = wallet_sol + active_exposure_sol
reserve_sol             = max(override_SOL, total_capital_sol * ENTRY_RESERVE_SOL_PCT / 100)
min_position_sol        = max(override_SOL, total_capital_sol * ENTRY_MIN_POSITION_SOL_PCT / 100)
max_position_sol        = total_capital_sol * ENTRY_MAX_POSITION_SOL_PCT / 100
max_deployable_sol      = total_capital_sol * ENTRY_MAX_TOTAL_EXPOSURE_PCT / 100
remaining_deployable    = max(0, max_deployable_sol - active_exposure_sol)
usable_wallet_sol       = max(0, wallet_sol - reserve_sol)
target_position_sol     = total_capital_sol * ENTRY_WALLET_ALLOCATION_PCT / 100
position_sol            = min(target_position_sol, usable_wallet_sol, remaining_deployable, max_position_sol)
```

La position est refusee si `position_sol < min_position_sol`. Les anciens champs absolus `ENTRY_MIN_SOL_RESERVE`, `ENTRY_MIN_POSITION_SOL` et `ENTRY_MAX_POSITION_SOL` restent disponibles comme overrides optionnels; avec `0`, seuls les ratios pilotent le sizing. Avec `ENTRY_REQUIRE_SOL_POOL=true`, seules les pools contenant SOL sont candidates. Avec `ENTRY_SOL_ONLY=true`, le bot envoie seulement le cote SOL de la position (`singleSidedX=true` si SOL est token X, `singleSidedX=false` si SOL est token Y) et desactive l'auto-fill du deuxieme token. C'est volontaire pour un wallet de test finance uniquement en SOL: une vraie position balancee demanderait soit de posseder deja le token risque, soit d'ajouter une etape de swap avant l'ajout de liquidite.

### MeteoraDlmmClient

Toutes les operations on-chain passent par le SDK officiel:

- `DLMM.create(connection, poolAddress, opt)`;
- `getActiveBin()`;
- `initializePositionAndAddLiquidityByStrategy(...)`;
- `getPositionsByUserAndLbPair(owner)`;
- `removeLiquidity({ bps: 10000, shouldClaimAndClose: true })`.

Note SDK importante: certains exemples anciens mentionnent `liquiditiesBpsToRemove`; les types de `@meteora-ag/dlmm@1.9.10` exposent `bps: BN` pour `removeLiquidity`.

### RpcService

`RpcService` prepare chaque transaction avec un blockhash frais, `feePayer`, compute budget optionnel, signature, envoi raw transaction, puis confirmation par strategie `{ blockhash, lastValidBlockHeight, signature }`. Les erreurs retryables sont les expirations blockhash, transactions dropees, rate limits et erreurs reseau temporaires.

## Mecanique des bins DLMM

Un pool DLMM est une echelle de bins a prix fixe. Pour un bin `i`:

```text
P_i = (1 + bin_step / 10_000)^i
L_i = P_i * x_i + y_i
```

Dans un bin, le prix est fixe; le swap consomme la liquidite du bin actif puis traverse les bins suivants. La position LP detient des parts par bin. Quand le prix se deplace, la composition X/Y de la position change: c'est l'effet de divergence temporaire, equivalent a une impermanent loss realisee seulement si on retire.

La strategie `BidAsk` place de la liquidite autour du bin actif de facon a capter le flux dans les deux directions. Le bot choisit:

```text
minBinId = activeBin - BID_ASK_HALF_WIDTH_BINS
maxBinId = activeBin + BID_ASK_HALF_WIDTH_BINS
strategyType = StrategyType.BidAsk
```

## Calcul du profit reel

Le bot ne declenche pas le TP sur les fees bruts seuls. Il valorise la position actuelle plus les fees non claim, puis compare au capital initial.

Definitions:

```text
X0, Y0        = montants deposes a l'entree
Px0, Py0      = prix USD des tokens a l'entree
Xt, Yt        = montants de liquidite retirables actuellement
Fx_t, Fy_t    = fees claimables actuellement
CF_t          = fees deja claims, valorises au moment du claim ou du snapshot
Px_t, Py_t    = prix USD actuels des tokens
V0            = X0 * Px0 + Y0 * Py0
Vliq_t        = Xt * Px_t + Yt * Py_t
Vfees_t       = Fx_t * Px_t + Fy_t * Py_t
Vcurrent_t    = Vliq_t + Vfees_t + CF_t
profit_usd    = Vcurrent_t - V0
profit_pct    = profit_usd / V0 * 100
```

La divergence temporaire est mesuree contre le portefeuille HODL equivalent:

```text
Vhodl_t = X0 * Px_t + Y0 * Py_t
IL_usd  = Vliq_t - Vhodl_t
vs_hodl_pct = (Vcurrent_t - Vhodl_t) / Vhodl_t * 100
```

Cette mesure capture:

- changement de composition X/Y dans les bins;
- fees accumules par bin (`positionFeeXAmount`, `positionFeeYAmount` ou agregats `feeX`, `feeY`);
- variation de prix des deux tokens;
- sous-performance ou surperformance par rapport au HODL.

Les couts de transaction et rent peuvent etre ajoutes comme `cost_basis_adjustment_usd` si l'on veut un PnL net comptable complet.

## Sortie TP / SL

Si `profit_pct >= TAKE_PROFIT_PCT`, le monitoring passe la position en `EXITING` avec `exitReason=TAKE_PROFIT`.

Si `profit_pct <= STOP_LOSS_PCT`, le meme chemin de sortie est utilise avec `exitReason=STOP_LOSS`.
La config accepte `STOP_LOSS_PCT=12` ou `STOP_LOSS_PCT=-12`; elle normalise toujours la valeur en seuil negatif.

Dans les deux cas, il recupere les bins encore porteurs de liquidite/fees et appelle:

```ts
removeLiquidity({
  user,
  position,
  fromBinId,
  toBinId,
  bps: new BN(10_000),
  shouldClaimAndClose: true,
})
```

Le SDK peut retourner plusieurs transactions. Elles sont envoyees sequentiellement pour garder l'etat de position coherent.

## Gestion d'erreurs

### Slippage et deplacement du bin actif

Le SDK utilise `slippage` comme pourcentage pour borner les montants max de depot/retrait et convertir le mouvement admissible du bin actif. Le bot conserve une valeur faible par defaut (`0.5`) et refetch l'etat avant chaque transaction.

### Transactions dropees

Solana peut drop une transaction sans erreur definitive. Le bot:

- utilise un blockhash frais a chaque tentative;
- confirme avec `lastValidBlockHeight`;
- retry sur timeout, expiration blockhash, HTTP 429/503 et erreurs reseau;
- n'insiste pas sur les erreurs programme explicites, manque de fonds, slippage, compte inexistant.

### Rate limits RPC/API

- Meteora Data API: limite documentee de 30 RPS, le client limite les appels.
- DexScreener et RugCheck: clients avec rate gate et backoff exponentiel.
- Monitoring: concurrence bornee (`MONITOR_CONCURRENCY`) et polling par intervalle, pas une boucle par position.

### Risque rug

Une pool est rejetee si:

- Meteora marque `is_blacklisted=true`;
- RugCheck retourne un score normalise au-dessus du seuil;
- RugCheck expose un risque de niveau dangereux;
- Jupiter Tokens V2 expose `audit.isSus`, `organicScore` trop bas, `organicScoreLabel=low`, liquidite/holders insuffisants, top holders trop concentres, dev balance excessive, mint authority ou freeze authority active;
- token non verifie alors que `SCANNER_REQUIRE_TOKEN_VERIFIED=true`;
- l'API risque echoue et `RUGCHECK_FAIL_CLOSED=true`.

Les mints systemiques (SOL, USDC, USDT) sont traites comme mints de confiance si RugCheck/Jupiter ne renvoie pas de rapport exploitable.

Jupiter peut autoriser un token non encore verifie par Meteora si `SCANNER_ALLOW_UNVERIFIED_IF_JUPITER_PASSES=true`, mais seulement si tous les mints de la pool ont un organic score superieur a `JUPITER_HIGH_CONFIDENCE_ORGANIC_SCORE` et aucun signal dangereux.
