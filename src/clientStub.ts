import "isomorphic-fetch"; // tslint:disable-line no-import-side-effect
import * as jwt from "jsonwebtoken";

import { APIError, APIResultError } from "./errors";
import {
    Assigned,
    LoginResponse,
    Mutation,
    Operation,
    Payload,
    Request,
    Response,
    TxnContext,
    UiKeywords,
} from "./types";

declare const fetch: any; // tslint:disable-line no-any

// milliseconds before doing automatic token refresh
const AUTO_REFRESH_PREFETCH_TIME = 5000;

/**
 * Stub is a stub/client connecting to a single dgraph server instance.
 */
export class DgraphClientStub {
    private readonly addr: string;
    private legacyApi: boolean;
    private accessToken: string;
    private refreshToken: string;
    private autoRefresh: boolean;
    private autoRefreshTimer?: number;

    constructor(addr?: string, legacyApi?: boolean) {
        if (addr === undefined) {
            this.addr = "http://localhost:8080"; // tslint:disable-line no-http-string
        } else {
            this.addr = addr;
        }
        this.legacyApi = !!legacyApi;
    }

    public async detectApiVersion(): Promise<string> {
        const health = await this.health();
        this.legacyApi = health.version.startsWith("1.0.");
        return health.version;
    }

    public alter(op: Operation): Promise<Payload> {
        let body: string;
        if (op.schema !== undefined) {
            body = op.schema;
        } else if (op.dropAttr !== undefined) {
            body = JSON.stringify({ drop_attr: op.dropAttr });
        } else if (op.dropAll) {
            body = JSON.stringify({ drop_all: true });
        } else {
            return Promise.reject("Invalid op argument in alter");
        }

        return this.callAPI("alter", {
            method: "POST",
            body,
        });
    }

    public query(req: Request): Promise<Response> {
        const headers: { [k: string]: string } = {};
        if (req.vars !== undefined) {
          if (this.legacyApi) {
              headers["X-Dgraph-Vars"] = JSON.stringify(req.vars);
          } else {
            headers["Content-Type"] = "application/json";
            req.query = JSON.stringify({
                query: req.query,
                variables: req.vars,
            });
          }
        }
        if (headers["Content-Type"] === undefined && !this.legacyApi) {
            headers["Content-Type"] = "application/graphql+-";
        }

        let url = "query";

        if (this.legacyApi) {
          if (req.startTs !== 0) {
            url += `/${req.startTs}`;
          }
          if (req.debug) {
            url += "?debug=true";
          }
        } else {
          const params: { key: string; value: string }[] = [];
          if (req.startTs !== 0) {
            params.push({
              key: "startTs",
              value: `${req.startTs}`,
            });
          }
          if (req.timeout > 0) {
            params.push({
              key: "timeout",
              value: `${req.timeout}s`,
            });
          }
          if (req.debug) {
            params.push({
              key: "debug",
              value: "true",
            });
          }
          if (req.readOnly) {
            params.push({
              key: "ro",
              value: "true",
            });
          }
          if (req.bestEffort) {
            params.push({
              key: "be",
              value: "true",
            });
          }
          if (params.length > 0) {
              url += "?";
              url += params.map(
                ({ key, value }: { key: string; value: string }): string => `${key}=${value}`,
              ).join("&");
          }
        }
        headers["Content-Type"] = "application/graphql+-";

        return this.callAPI(url, {
            method: "POST",
            body: req.query,
            headers,
        });
    }

    public mutate(mu: Mutation): Promise<Assigned> {
        let body: string;
        let usingJSON: boolean = false;
        if (mu.setJson !== undefined || mu.deleteJson !== undefined) {
            usingJSON = true;
            const obj: { [k: string]: object } = {};
            if (mu.setJson !== undefined) {
                obj.set = mu.setJson;
            }
            if (mu.deleteJson !== undefined) {
                obj.delete = mu.deleteJson;
            }

            body = JSON.stringify(obj);
        } else if (mu.setNquads !== undefined || mu.deleteNquads !== undefined) {
            body = `{
                ${mu.setNquads === undefined ? "" : `set {
                    ${mu.setNquads}
                }`}
                ${mu.deleteNquads === undefined ? "" : `delete {
                    ${mu.deleteNquads}
                }`}
            }`;
        } else if (mu.mutation !== undefined) {
          body = mu.mutation;
          if (mu.isJsonString !== undefined) {
            // Caller has specified mutation type
            usingJSON = mu.isJsonString;
          } else {
            // Detect content-type
            try {
              JSON.parse(mu.mutation);
              usingJSON = true;
            } catch (e) {
              usingJSON = false;
            }
          }
        } else {
            return Promise.reject("Mutation has no data");
        }

        const headers: { [k: string]: string } = {
          "Content-Type": `application/${usingJSON ? "json" : "rdf"}`,
        };
        if (usingJSON && this.legacyApi) {
            headers["X-Dgraph-MutationType"] = "json";
        }

        let url = "mutate";
        let nextDelim = "?";
        if (mu.startTs > 0) {
            url += (!this.legacyApi ? `?startTs=` : `/`) + mu.startTs.toString();
            nextDelim = "&";
        }

        if (mu.commitNow) {
            if (!this.legacyApi) {
              url += `${nextDelim}commitNow=true`;
            } else {
                headers["X-Dgraph-CommitNow"] = "true";
            }
        }

        return this.callAPI(url, {
            method: "POST",
            body,
            headers,
        });
    }

    public commit(ctx: TxnContext): Promise<TxnContext> {
        let body: string;
        if (ctx.keys === undefined) {
            body = "[]";
        } else {
            body = JSON.stringify(ctx.keys);
        }

        const url = !this.legacyApi
            ? `commit?startTs=${ctx.start_ts}`
            : `commit/${ctx.start_ts}`;

        return this.callAPI(url, {
            method: "POST",
            body,
        });
    }

    public abort(ctx: TxnContext): Promise<TxnContext> {
        const url = !this.legacyApi
            ? `commit?startTs=${ctx.start_ts}&abort=true`
            : `/abort/${ctx.start_ts}`;

        return this.callAPI(url, { method: "POST" });
    }

    public async health(): Promise<{ health: string; version: string; instance?: string; uptime?: number }> {
        const response: { status: number; text(): Promise<string> } =
            await fetch(this.getURL("health"), { // tslint:disable-line no-unsafe-any
                method: "GET",
            });
        if (response.status >= 300 || response.status < 200) {
            throw new Error(`Invalid status code = ${response.status}`);
        }
        const text = await response.text();
        if (text === "OK") {
          return {
            health: text,
            version: "1.0.x",
          };
        }
        return {
          ...JSON.parse(text),
          health: "OK",
        };
    }

    public async login(userid?: string, password?: string, refreshToken?: string): Promise<boolean> {
      if (this.legacyApi) {
        throw new Error("Pre v1.1 clients do not support Login methods");
      }

      const body: { [k: string]: string } = {};
      if (userid === undefined && refreshToken === undefined && this.refreshToken === undefined) {
        throw new Error("Cannot find login details: neither userid/password nor refresh token are specified");
      }
      if (userid === undefined) {
        body.refresh_token = refreshToken !== undefined ? refreshToken : this.refreshToken;
      } else {
        body.userid = userid;
        body.password = password;
      }

      const res: LoginResponse = await this.callAPI("login", {
        method: "POST",
        body: JSON.stringify(body),
      });
      this.accessToken = res.data.accessJWT;
      this.refreshToken = res.data.refreshJWT;

      this.maybeStartRefreshTimer(this.accessToken);
      return true;
    }

    public logout(): void {
        this.accessToken = undefined;
        this.refreshToken = undefined;
    }

    public getAuthTokens(): { accessToken?: string; refreshToken?: string } {
        return {
          accessToken: this.accessToken,
          refreshToken: this.refreshToken,
        };
    }

    public async fetchUiKeywords(): Promise<UiKeywords> {
      return this.callAPI("ui/keywords", {});
    }


    /**
     * Gets instance or cluster health, based on the all param
     *
     * @param {boolean} [all=false] Whether to get the health of the full cluster 
     * @returns {Promise<Response>} Health in JSON
     * @memberof DgraphClientStub
     */
    public async getHealth(all: boolean = false): Promise<Response> {
      const url = "health" + (all? "?all" : "");

      return await this.callAPI(url, {
        method: "GET",
      });
    }

    /**
     * Gets the state of the cluster
     *
     * @returns {Promise<Response>} State in JSON
     * @memberof DgraphClientStub
     */
    public async getState(): Promise<Response> {
      return await this.callAPI("state", {
        method: "GET",
      });
    }


    public setAutoRefresh(val: boolean) {
        if (!val) {
          this.cancelRefreshTimer();
        }
        this.autoRefresh = val;
        this.maybeStartRefreshTimer(this.accessToken);
    }

    private cancelRefreshTimer() {
      if (this.autoRefreshTimer !== undefined) {
        clearTimeout(<any>this.autoRefreshTimer);
        this.autoRefreshTimer = undefined;
      }
    }

    private maybeStartRefreshTimer(accessToken?: string) {
      if (accessToken === undefined || !this.autoRefresh) {
        return;
      }
      this.cancelRefreshTimer();

      const timeToWait = Math.max(
          2000,
          jwt.decode(accessToken).exp * 1000 - Date.now()
              - AUTO_REFRESH_PREFETCH_TIME);

      this.autoRefreshTimer = <any>setTimeout(
          () => this.refreshToken && this.login(),
          timeToWait,
      );
    }

    private async callAPI<T>(path: string, config: { method?: string; body?: string; headers?: { [k: string]: string } }): Promise<T> {
        const url = this.getURL(path);
        if (this.accessToken !== undefined && path !== "login") {
          config.headers = config.headers !== undefined ? config.headers : {};
          config.headers["X-Dgraph-AccessToken"] = this.accessToken;
        }

        const response = await fetch(url, config);

        if (response.status >= 300 || response.status < 200) {
            throw new Error(`Invalid status code = ${response.status}`);
        }

        const json = await response.json();
        const errors = (<{ errors: APIResultError[] }><any>json).errors; // tslint:disable-line no-any

        if (errors !== undefined) {
            throw new APIError(url, errors);
        }

        return json;
    }

    private getURL(path: string): string {
        return `${this.addr}${this.addr.endsWith("/") ? "" : "/"}${path}`;
    }
}
