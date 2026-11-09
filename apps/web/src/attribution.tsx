import { useEffect, useState, type FormEvent } from "react";
import type { AttributionReview } from "../../../packages/sdk/src/context/runtime";
import type {
  Claim,
  CreatorContribution,
  Originality,
  ProvenanceEdge,
  SourceDocument,
} from "../../../packages/sdk/src/context/schema";

type Attribution = {
  claims: Claim[];
  sources: Pick<
    SourceDocument,
    "id" | "title" | "kind" | "url" | "accessType" | "author"
  >[];
  edges: ProvenanceEdge[];
  reviews: AttributionReview[];
  contributions: CreatorContribution[];
  authorReviews: { sourceId: string; author: string; reason: string }[];
};
const labels: Record<Originality, string> = {
  original: "博主原创",
  mixed: "引用了资料，也有博主自己的见解",
  derivative: "主要来自其他资料",
  unresolved: "出处待确认",
};
const relations: Record<ProvenanceEdge["relation"], string> = {
  quotes: "引用",
  paraphrases: "转述",
  translates: "翻译",
  summarizes: "概括",
  applies: "应用",
  extends: "延伸",
  critiques: "批评",
  curates: "选编",
  supports: "支持",
};
const access: Record<string, string> = {
  paywalled: "付费阅读",
  private: "需访问权限",
  deleted: "已删除",
};
const safeUrl = (url: string | null) =>
  url && /^https?:\/\//i.test(url) ? url : undefined;

export function AttributionPanel({
  load,
  save,
  saveAuthor,
  onChange,
  focusClaim,
}: {
  load: () => Promise<Attribution>;
  save: (
    claimId: string,
    review: Pick<
      AttributionReview,
      "originality" | "excludedEdges" | "reason" | "contribution"
    > | null,
  ) => Promise<unknown>;
  saveAuthor: (
    sourceId: string,
    review: { author: string; reason: string } | null,
  ) => Promise<unknown>;
  onChange: () => void;
  focusClaim: { id: string } | null;
}) {
  const [data, setData] = useState<Attribution | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState(false);
  const [originality, setOriginality] = useState<Originality>("unresolved");
  const [excluded, setExcluded] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [contributionDraft, setContributionDraft] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [author, setAuthor] = useState("");
  const [authorReason, setAuthorReason] = useState("");
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let current = true;
    load()
      .then((result) => {
        if (current) setData(result);
      })
      .catch((error) => {
        if (current) setStatus(error.message);
      });
    return () => {
      current = false;
    };
  }, [load]);

  useEffect(() => {
    if (!focusClaim) return;
    setQuery("");
    setSelected(focusClaim.id);
    setEditing(false);
    document
      .getElementById("attribution-panel")
      ?.scrollIntoView({ block: "start" });
  }, [focusClaim]);

  const claims =
    data?.claims.filter((claim) =>
      claim.text.toLowerCase().includes(query.trim().toLowerCase()),
    ) ?? [];
  const claim = claims.find((item) => item.id === selected) ?? claims[0];
  const review = data?.reviews.find((item) => item.claimId === claim?.id);
  const edges =
    data?.edges.filter((edge) => edge.fromClaimId === claim?.id) ?? [];
  const contribution = data?.contributions?.find(
    (item) => item.claimId === claim?.id,
  );
  const origin = data?.sources.find(
    (source) => source.id === `xhs-${claim?.noteId}`,
  );
  const source = (id?: string) => data?.sources.find((item) => item.id === id);
  const authorReview = data?.authorReviews?.find(
    (item) => item.sourceId === sourceId,
  );
  const changeAuthor = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!sourceId || pending) return;
    setPending(true);
    try {
      await saveAuthor(
        sourceId,
        event ? { author: author.trim(), reason: authorReason.trim() } : null,
      );
      setData(await load());
      onChange();
      setSourceId("");
      setStatus(event ? "作者信息已更新。" : "已恢复原来的作者信息。");
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "没能保存。请再试一次。",
      );
    } finally {
      setPending(false);
    }
  };
  const changeReview = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!claim || pending) return;
    setPending(true);
    try {
      await save(
        claim.id,
        event
          ? {
              originality,
              excludedEdges: excluded,
              reason: reason.trim(),
              contribution:
                contributionDraft.trim() !== (contribution?.description ?? "")
                  ? contributionDraft.trim()
                  : review?.contribution,
            }
          : null,
      );
      setData(await load());
      onChange();
      setEditing(false);
      setStatus(
        event
          ? "已保存。搜索和问答会使用更新后的信息。"
          : "已恢复 Cluefolio 最初找到的来源。",
      );
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "没能保存。请再试一次。",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="context-card attribution-card" id="attribution-panel">
      <h2>观点出处</h2>
      <p className="subtle">查看博主的原笔记，以及哪些内容引用了其他资料。</p>
      {status && (
        <p className="subtle" role="status">
          {status}
        </p>
      )}
      {!data && !status && <p className="subtle">正在查找观点和出处…</p>}
      {data && (
        <>
          <div className="attribution-controls">
            <label>
              搜索观点
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setEditing(false);
                }}
                placeholder="输入观点里的关键词"
              />
            </label>
            <label>
              选择观点
              <select
                value={claim?.id ?? ""}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setEditing(false);
                }}
              >
                {!claim && <option value="">没有找到相关观点</option>}
                {claims.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.text}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {claim && (
            <div className="attribution-flow">
              <div className="flow-origin">
                <span className="eyebrow">博主的观点</span>
                <p>{claim.text}</p>
                <span className="badge">
                  {labels[claim.originality]}
                  {review && " · 已手动更正"}
                </span>
                {contribution && (
                  <p className="subtle">
                    <strong>博主补充了什么</strong> {contribution.description}
                  </p>
                )}
                {origin && safeUrl(origin.url) && (
                  <a
                    href={safeUrl(origin.url)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    打开原笔记
                  </a>
                )}
              </div>
              <div className="flow-sources">
                <div className="eyebrow">引用或参考的资料 · {edges.length}</div>
                {!edges.length && (
                  <p className="subtle">暂时没找到与这条观点有关的其他资料。</p>
                )}
                <ul>
                  {edges.map((edge) => {
                    const item = source(edge.toSourceId);
                    const url = item && safeUrl(item.url);
                    return (
                      <li key={edge.id}>
                        {editing && (
                          <input
                            type="checkbox"
                            aria-label={`排除 ${item?.title ?? edge.id}`}
                            checked={excluded.includes(edge.id)}
                            onChange={(event) =>
                              setExcluded(
                                event.target.checked
                                  ? [...excluded, edge.id]
                                  : excluded.filter((id) => id !== edge.id),
                              )
                            }
                          />
                        )}
                        <div>
                          <strong>
                            {url ? (
                              <a href={url} target="_blank" rel="noreferrer">
                                {item.title} ↗
                              </a>
                            ) : (
                              (item?.title ?? edge.toClaimId)
                            )}
                          </strong>
                          <small>
                            {relations[edge.relation]} · 涉及约{" "}
                            {Math.round(edge.coverage * 100)}% 的观点内容
                            {item &&
                              access[item.accessType] &&
                              ` · ${access[item.accessType]}`}
                            {review?.excludedEdges.includes(edge.id) &&
                              " · 已移出来源列表"}
                          </small>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
              {!editing ? (
                <div className="review-actions">
                  {review && <p className="subtle">{review.reason}</p>}
                  <button
                    onClick={() => {
                      setOriginality(claim.originality);
                      setExcluded(review?.excludedEdges ?? []);
                      setReason(review?.reason ?? "");
                      setContributionDraft(contribution?.description ?? "");
                      setEditing(true);
                    }}
                  >
                    更正出处
                  </button>
                  {review && (
                    <button
                      onClick={() => void changeReview()}
                      disabled={pending}
                    >
                      恢复原来的出处
                    </button>
                  )}
                </div>
              ) : (
                <form
                  className="review-form"
                  onSubmit={(event) => void changeReview(event)}
                >
                  <p className="subtle">
                    勾选关联有误的资料，把它们从这条观点的来源中移除。
                  </p>
                  <label>
                    这条观点主要来自哪里
                    <select
                      value={originality}
                      onChange={(event) =>
                        setOriginality(event.target.value as Originality)
                      }
                    >
                      {Object.entries(labels).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    博主补充了什么
                    <textarea
                      rows={2}
                      maxLength={2000}
                      value={contributionDraft}
                      onChange={(event) =>
                        setContributionDraft(event.target.value)
                      }
                    />
                  </label>
                  <label>
                    为什么更正
                    <textarea
                      required
                      rows={2}
                      maxLength={2000}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </label>
                  <div className="review-actions">
                    <button
                      className="primary"
                      disabled={pending || !reason.trim()}
                    >
                      保存更正
                    </button>
                    <button type="button" onClick={() => setEditing(false)}>
                      取消
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
          <details className="source-index">
            <summary>全部来源 · {data.sources.length}</summary>
            <ul>
              {data.sources.map((item) => (
                <li key={item.id}>
                  {safeUrl(item.url) ? (
                    <a
                      href={safeUrl(item.url)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {item.title} ↗
                    </a>
                  ) : (
                    item.title
                  )}
                  <small>
                    {item.author || "作者未知"}
                    {access[item.accessType] && ` · ${access[item.accessType]}`}
                  </small>
                  <button
                    className="text-button"
                    onClick={() => {
                      setSourceId(item.id);
                      setAuthor(item.author ?? "");
                      setAuthorReason(
                        data.authorReviews.find(
                          (review) => review.sourceId === item.id,
                        )?.reason ?? "",
                      );
                    }}
                  >
                    更正作者
                  </button>
                  {sourceId === item.id && (
                    <form
                      className="review-form"
                      onSubmit={(event) => void changeAuthor(event)}
                    >
                      <label>
                        作者
                        <input
                          value={author}
                          required
                          maxLength={200}
                          onChange={(event) => setAuthor(event.target.value)}
                        />
                      </label>
                      <label>
                        为什么更正作者
                        <textarea
                          value={authorReason}
                          required
                          maxLength={2000}
                          onChange={(event) =>
                            setAuthorReason(event.target.value)
                          }
                        />
                      </label>
                      <div className="review-actions">
                        <button
                          className="primary"
                          disabled={
                            pending || !author.trim() || !authorReason.trim()
                          }
                        >
                          保存作者信息
                        </button>
                        {authorReview && (
                          <button
                            type="button"
                            onClick={() => void changeAuthor()}
                            disabled={pending}
                          >
                            恢复原来的作者信息
                          </button>
                        )}
                        <button type="button" onClick={() => setSourceId("")}>
                          取消
                        </button>
                      </div>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
