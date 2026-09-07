# dsh-rest-adapter

[English](README.md) | 涓枃

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)锛圖SH锛夌殑鏈湴 HTTP REST 妗ユ帴鎻掍欢锛氱粰澶栭儴搴旂敤锛堟墜鏈?App銆丳ython 妗ユ帴鑴氭湰銆佽皟搴﹀櫒锛夋彁渚涗竴濂楁爣鍑?HTTP 鎺у埗闈㈡潵椹卞姩鏈湴 DSH 鏅鸿兘浣撯€斺€?*鍏ㄧ▼涓嶅嚭鍏綉**銆傝矾鐢辨寕鍦ㄧ幇鏈?Web 鏈嶅姟鍣ㄧ鍙ｄ笂锛堥粯璁?`127.0.0.1:3080`锛夛紝骞剁粡鐢辨祻瑙堝櫒鍚屾 API 缃戝叧搴旂瓟锛屽洜姝?REST 鎵€鍋氱殑涓€鍒囬兘浼氬嚭鐜板湪 DSH 缃戦〉鐣岄潰閲岋紝涓斿叡浜悓涓€鎵逛細璇濄€?
## 瀹夎

闇€瑕?DSH `0.1.x` + `web` profile銆?
```powershell
# 浠?GitHub 瀹夎锛堟帹鑽愶級
dsh plugin --profile web add github:lx00924-lx/DeepSeekREST

# 鎴栨湰鍦板厠闅嗗畨瑁?dsh plugin --profile web add link:D:\path\to\dsh-rest-adapter
```

鐒跺悗閲嶅惎 `dsh web` 骞跺埛鏂版祻瑙堝櫒銆傛彃浠朵細鍑虹幇鍦ㄣ€岃缃?鈫?鎻掍欢銆嶅垪琛ㄩ噷锛宍GET /health` 浼氳繑鍥炵鐐规竻鍗曘€?
> 濡傛灉浣犵殑 DSH 宸插唴缃湰鎻掍欢锛岃鍕块噸澶嶅畨瑁呪€斺€旈噸澶嶆敞鍐岃矾鐢变細瀵艰嚧鍚姩澶辫触銆?
## 绔偣锛坄http://127.0.0.1:3080`锛?
| 鏂规硶 | 璺緞 | 鐢ㄩ€?|
|---|---|---|
| GET | `/health` | 瀛樻椿鎺㈤拡 + 绔偣娓呭崟 |
| POST | `/v1/chat/completions` | OpenAI 鍏煎瀵硅瘽锛堥潪娴佸紡锛?|
| POST | `/v1/agent/prompt` | 璺戜竴杞紝杩斿洖鏈€缁堟枃鏈紙鍚屾锛?|
| POST | `/v1/agent/prompt/stream` | **SSE 娴佸紡杞?*锛氭€濊€?鍥炵瓟澧為噺銆佸伐鍏峰崱鐗囥€佸鎵广€佸績璺?|
| POST | `/v1/agent/abort` | 鎸?`{ sessionId }` 涓柇 |
| GET | `/v1/models` | 妯″瀷鐩綍 + 鎬濊€冩。浣嶏紙`?sessionId=` 闄勫甫璇ヤ細璇濆綋鍓嶉€夋嫨锛?|
| GET | `/v1/sessions` | 浼氳瘽鍒楄〃 |
| PATCH | `/v1/sessions/:id` | 閲嶅懡鍚嶄細璇?`{ title }` |
| DELETE | `/v1/sessions/:id` | 浠庡伐浣滃尯褰掓。浼氳瘽 |
| GET | `/v1/sessions/:id/tools` | 宸ュ叿鎵ц鐘舵€侊紙`?limit=N`锛?|
| POST | `/v1/sessions/:id/abort` | 鍋滄褰撳墠杞?|
| POST | `/v1/sessions/:id/approve` | 绛斿鎸傝捣鐨勫鎵?`{ approvalId, action: "allow" | "deny" }` |
| GET | `/v1/plugins` | 鎻掍欢娓呭崟 |

鎵€鏈夎矾鐢卞甫 `Access-Control-Allow-Origin: *`锛宍OPTIONS` 杩斿洖 204銆?
## 鍙戞秷鎭殑璇锋眰瀛楁

```json
{
  "sessionId": "鍙€夛紝涓嶄紶鑷姩鏂板缓锛堝搷搴斾腑杩斿洖锛?,
  "prompt": "璁╂櫤鑳戒綋鍋氫粈涔?,
  "model": "deepseek-v4-flash",
  "reasoningEffort": "high",
  "permission": "workspace-write"
}
```

- `model` / `reasoningEffort` 鈥斺€?杞寮€濮嬪墠缁忕綉鍏?`session.selectModel` 鐢熸晥锛涜泧褰?`reasoning_effort` 鍚屾牱鎺ュ彈銆?- `permission` 鈥斺€?`read-only` | `workspace-write` | `danger-full-access`锛坄/permission` 棰勮锛涘父瑙佸埆鍚嶈嚜鍔ㄥ綊涓€鍖栵級銆傚垏鎹㈤璁句細娉ㄥ叆涓€鏉°€岀瓥鐣ュ凡鍙樻洿銆嶆彁绀猴紝妯″瀷鍙兘鍏堝洖搴斿畠鈥斺€斿缓璁湪鏂颁細璇濈殑绗竴鏉℃秷鎭氨甯︿笂銆?- `sessionId` 澶嶇敤 = 缁亰鏃㈡湁浼氳瘽锛堢粷涓嶉噸寤猴級銆?
## SSE 浜嬩欢

`event: reasoning` 鈫?`{content}`锛堟€濊€冨閲忥級路 `event: content` 鈫?`{content}`锛堝洖绛斿閲忥級路 `event: tool_start` 鈫?`{id, tool, input}` 路 `event: tool_end` 鈫?`{id, tool, output, status}` 路 `event: waiting_approval` 鈫?`{approvalId, tool}` 路 `event: approval_resolved` 鈫?`{approvalId, outcome}` 路 `event: done` 鈫?`{sessionId, status, title?}` 路 `event: error` 鈫?`{message}`銆傜┖闂叉椂姣?5 绉掑彂涓€娆?`: keep-alive`锛涜繛鎺ユ柇寮€浼氭寜銆屽彇娑堛€嶅鐞嗚浼氳瘽鎸傝捣鐨勫鎵广€?
## 閰嶇疆

鍙€夋彃浠堕厤缃紙鏀惧湪鍚庣画 patch 灞傦級锛歚turnTimeoutMs`锛?00000锛夈€乣pollIntervalMs`锛?00锛夈€乣maxBodyBytes`锛?0485760锛夈€乣defaultToolLimit`锛?0锛夈€乣maxToolLimit`锛?00锛夈€乣maxToolResultChars`锛?000锛夈€?
## 鏋勫缓

闅忓寘鍙戝竷鐨?`lib/index.js` 鏄嚜鍖呭惈 bundle锛涙簮鐮佹潵鑷?DSH 宸ヤ綔鍖猴紙`packages/host/rest-adapter`锛夈€傜嫭绔嬮噸鏋勫缓鏃讹紝鐢ㄤ綘椤烘墜鐨勬墦鍖呭櫒鎶婂閮ㄥ鍏ワ紙`@deepseek-ai/dsh-host-apiproxy` 鐨?`toFetchHandler`銆乣@deepseek-ai/schemastery` 鐨?`z`锛夊唴鑱旇繘浜х墿鍗冲彲銆?