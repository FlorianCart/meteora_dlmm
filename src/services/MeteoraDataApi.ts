import type { MeteoraPool, MeteoraPoolsResponse } from "../types.js";
import { HttpClient } from "./HttpClient.js";

interface ListPoolsParams {
  page?: number;
  pageSize?: number;
  query?: string;
  sortBy?: string;
  filterBy?: string;
}

export class MeteoraDataApi {
  constructor(private readonly http: HttpClient) {}

  listPools(params: ListPoolsParams = {}): Promise<MeteoraPoolsResponse> {
    return this.http.getJson<MeteoraPoolsResponse>("/pools", {
      query: {
        page: params.page ?? 1,
        page_size: params.pageSize ?? 100,
        query: params.query,
        sort_by: params.sortBy,
        filter_by: params.filterBy
      }
    });
  }

  async getPool(poolAddress: string): Promise<MeteoraPool> {
    const response = await this.http.getJson<MeteoraPool | { data: MeteoraPool }>(`/pools/${poolAddress}`);
    if (typeof response === "object" && response !== null && "data" in response) {
      return response.data;
    }
    return response as MeteoraPool;
  }
}
