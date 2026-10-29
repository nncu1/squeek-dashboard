// ABI fragments for the October 2026 Squeekchain deployment (release "squeeks-sepolia-dispenser-20261024-06").
// Squeeks live in the "Squeek - Sealed" collection, which merges them itself; earning power comes from Squeeks
// deposited in the staking vault. Only standard ERC-721 Transfer logs and a few views are read from chain.
import { parseAbi, parseAbiItem, toEventSelector } from "viem";

// SqueekCore V3 (same interface as the earlier deployment)
export const coreAbi = parseAbi([
  "function state() view returns ((uint64 settledThroughRound, uint64 cumulativeWork, uint96 cumulativeBlockUnits, uint64 blockHeight, uint96 blockProgress, uint32 workPerThousandBlocks, uint256 authorizationNonce, bool paused))",
]);

export const nftAbi = parseAbi([
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function level(uint256 tokenId) view returns (uint256)",
]);

// Views that may hold a Squeek's next merge height. The contract is unverified, so the indexer probes these once
// and uses the first one that answers; otherwise it takes the height from the merge log.
export const NEXT_MERGE_GETTERS = ["nextMergeHeight", "nextMergeBlock", "mergeReadyAt", "cooldownUntil", "nextMergeAt"]
  .map((name) => parseAbi([`function ${name}(uint256 tokenId) view returns (uint256)`])[0]);

export const events = {
  transfer: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"),
};

// Logs from the NFT that are never the merge record, even when they carry a token id.
export const IGNORED_TOPICS = new Set([
  "event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)",
  "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
  "event MetadataUpdate(uint256 _tokenId)",
  "event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
].map((s) => toEventSelector(parseAbiItem(s))));

export const TRANSFER_TOPIC = toEventSelector(events.transfer);

// Values from /v1/economy/state for this release, used until the API answers.
export const DEFAULT_POLICY = {
  maxLevel: 10,
  basePower: [1000, 2200, 4840, 10648, 23426, 51536, 113380, 249436, 548759, 1207269],
  // core blocks a Squeek waits after a merge brings it to level n (index n-1)
  cooldown: [0, 3000, 7000, 14000, 21000, 28000, 35000, 42000, 49000, 0],
};
