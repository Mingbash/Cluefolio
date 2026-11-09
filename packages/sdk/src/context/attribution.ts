import type { Originality, ProvenanceEdge } from "./schema.ts";

export type OriginalityInput = {
  sourceCoverage: number;
  creatorContribution: number;
  boundedSearchComplete: boolean;
  crediblePriorMatch: boolean;
  explicitSourceInaccessible?: boolean;
  unresolvedHighSimilarity?: boolean;
};

export function classifyOriginality(input: OriginalityInput): { originality: Originality; basis: string } {
  if (input.explicitSourceInaccessible) return { originality: "unresolved", basis: "explicit_source_inaccessible" };
  if (input.unresolvedHighSimilarity) return { originality: "unresolved", basis: "high_similarity_relationship_unresolved" };
  if (input.sourceCoverage >= 0.7) {
    if (input.creatorContribution >= 0.3) return { originality: "mixed", basis: "high_upstream_coverage_with_creator_contribution" };
    return { originality: "derivative", basis: "high_upstream_coverage_low_creator_contribution" };
  }
  if (input.sourceCoverage > 0 || input.crediblePriorMatch) {
    if (input.creatorContribution >= 0.3) return { originality: "mixed", basis: "partial_upstream_relation_with_creator_contribution" };
    return { originality: "derivative", basis: "partial_upstream_relation_low_creator_contribution" };
  }
  return {
    originality: "original",
    basis: input.boundedSearchComplete ? "no_prior_match_after_bounded_search" : "no_prior_match_after_search_limit",
  };
}

export function finalizeAttemptedOriginality<T extends { originality: Originality; originalityBasis: string; sourceCoverage: number; creatorContribution: number }>(claims: T[]) {
  for (const claim of claims) {
    if (claim.originalityBasis !== "insufficient_attribution_evidence") continue;
    const result = classifyOriginality({
      sourceCoverage: claim.sourceCoverage,
      creatorContribution: claim.creatorContribution,
      boundedSearchComplete: true,
      crediblePriorMatch: claim.sourceCoverage > 0,
    });
    claim.originality = result.originality;
    claim.originalityBasis = result.basis;
  }
  return claims;
}

export function dedupeSourceFamilies(edges: ProvenanceEdge[]) {
  const best = new Map<string, ProvenanceEdge>();
  for (const edge of edges) {
    const key = `${edge.fromClaimId}:${edge.sourceFamily}`;
    const current = best.get(key);
    if (!current || edge.confidence * edge.coverage > current.confidence * current.coverage) best.set(key, edge);
  }
  return [...best.values()];
}

/** Background evidence can corroborate a point without establishing where it came from. */
export function isUpstreamOrigin(edge: ProvenanceEdge, upstream: string[] = [], creator: string[] = []) {
  if (!edge.verified || !edge.evidenceIds.length || edge.confidence < 0.85 || edge.coverage < 0.7)
    return false;
  if (["quotes", "translates", "summarizes"].includes(edge.relation)) return true;
  if (edge.relation !== "paraphrases") return false;
  // Preserve a distinctive same-language formulation. Similar topic or a common term is insufficient.
  return upstream.some(excerpt => {
    const han = excerpt.match(/\p{Script=Han}{10,}/gu) ?? [];
    return creator.some(text => han.some(phrase => {
      for (let start = 0; start <= phrase.length - 10; start++)
        if (text.includes(phrase.slice(start, start + 10))) return true;
      return false;
    }));
  });
}
