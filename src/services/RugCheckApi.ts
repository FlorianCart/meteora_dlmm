import type { RiskAssessment, RugCheckSummary, RugRisk } from "../types.js";
import { SOL_MINT, USDC_MINT, USDT_MINT } from "../types.js";
import { HttpClient, HttpError } from "./HttpClient.js";

interface RugCheckOptions {
  maxNormalizedScore: number;
  failClosed: boolean;
}

const DANGEROUS_LEVELS = new Set(["danger", "critical", "high", "rug"]);
const TRUSTED_SYSTEM_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

export class RugCheckApi {
  constructor(
    private readonly http: HttpClient,
    private readonly options: RugCheckOptions
  ) {}

  async assessToken(mint: string): Promise<RiskAssessment> {
    try {
      const summary = await this.http.getJson<RugCheckSummary>(`/v1/tokens/${mint}/report/summary`, {
        query: { cacheOnly: "true" }
      });
      return this.toAssessment(mint, summary);
    } catch (error) {
      if (TRUSTED_SYSTEM_MINTS.has(mint)) {
        return {
          mint,
          score: null,
          scoreNormalized: null,
          isDangerous: false,
          reasons: ["Trusted system mint; RugCheck unavailable ignored"]
        };
      }
      if (error instanceof HttpError && error.status === 404 && !this.options.failClosed) {
        return {
          mint,
          score: null,
          scoreNormalized: null,
          isDangerous: false,
          reasons: ["RugCheck report not cached"]
        };
      }
      return {
        mint,
        score: null,
        scoreNormalized: null,
        isDangerous: this.options.failClosed,
        reasons: [`RugCheck unavailable: ${error instanceof Error ? error.message : String(error)}`]
      };
    }
  }

  private toAssessment(mint: string, summary: RugCheckSummary): RiskAssessment {
    const risks = summary.risks ?? [];
    const dangerousRisks = risks.filter((risk) => this.isDangerousRisk(risk));
    const scoreNormalized = summary.score_normalised ?? summary.score ?? null;
    const scoreTooHigh =
      scoreNormalized !== null && Number.isFinite(scoreNormalized) && scoreNormalized > this.options.maxNormalizedScore;
    const reasons = [
      ...dangerousRisks.map((risk) => `${risk.level}:${risk.name}`),
      ...(scoreTooHigh ? [`score_normalised>${this.options.maxNormalizedScore}`] : [])
    ];

    return {
      mint,
      score: summary.score ?? null,
      scoreNormalized,
      isDangerous: reasons.length > 0,
      reasons,
      raw: summary
    };
  }

  private isDangerousRisk(risk: RugRisk): boolean {
    return DANGEROUS_LEVELS.has(risk.level.toLowerCase()) || risk.score >= 50;
  }
}
