// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Test doubles exposing the same views/events as the real Squeekchain contracts the dashboard reads.

library B64 {
    bytes internal constant T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    function encode(bytes memory data) internal pure returns (string memory) {
        if (data.length == 0) return "";
        uint256 len = 4 * ((data.length + 2) / 3);
        bytes memory out = new bytes(len);
        uint256 j;
        for (uint256 i = 0; i < data.length; i += 3) {
            uint256 a = uint8(data[i]);
            uint256 b = i + 1 < data.length ? uint8(data[i + 1]) : 0;
            uint256 c = i + 2 < data.length ? uint8(data[i + 2]) : 0;
            uint256 n = (a << 16) | (b << 8) | c;
            out[j++] = T[(n >> 18) & 63];
            out[j++] = T[(n >> 12) & 63];
            out[j++] = i + 1 < data.length ? T[(n >> 6) & 63] : bytes1("=");
            out[j++] = i + 2 < data.length ? T[n & 63] : bytes1("=");
        }
        return string(out);
    }
}

contract Multicall3Lite {
    struct Call3 { address target; bool allowFailure; bytes callData; }
    struct Result { bool success; bytes returnData; }
    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory r) {
        r = new Result[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory data) = calls[i].target.staticcall(calls[i].callData);
            require(ok || calls[i].allowFailure, "call failed");
            r[i] = Result(ok, data);
        }
    }
}

contract MockCore {
    struct CoreState {
        uint64 settledThroughRound; uint64 cumulativeWork; uint96 cumulativeBlockUnits; uint64 blockHeight;
        uint96 blockProgress; uint32 workPerThousandBlocks; uint256 authorizationNonce; bool paused;
    }
    uint64 public height;
    uint64 public settled;
    function setHeight(uint64 h, uint64 r) external { height = h; settled = r; }
    function state() external view returns (CoreState memory s) {
        s.settledThroughRound = settled; s.cumulativeWork = height * 11; s.cumulativeBlockUnits = uint96(height) * 1e9;
        s.blockHeight = height; s.workPerThousandBlocks = 10959;
    }
}

// "Squeek - Sealed": the collection merges Squeeks itself and keeps their level. Its merge log is not published;
// this one is a plausible shape, and the indexer reads it by shape, not by signature.
interface IVault { function depositorOf(uint256 id) external view returns (address); }

contract MockSealed {
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event MetadataUpdate(uint256 _tokenId);
    event SqueekMerged(address indexed account, uint256 indexed survivorTokenId, uint256 indexed donorTokenId, uint8 level, uint64 nextMergeHeight);

    mapping(uint256 => address) internal owners;
    mapping(uint256 => uint8) internal lvl;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    uint256 public nextId = 1;
    MockCore public core;
    address public vault;
    uint64[10] internal CD = [uint64(0), 3000, 7000, 14000, 21000, 28000, 35000, 42000, 49000, 0];

    constructor(MockCore c) { core = c; }
    function setVault(address v) external { vault = v; }
    function ownerOf(uint256 id) public view returns (address o) { o = owners[id]; require(o != address(0), "ERC721NonexistentToken"); }
    function level(uint256 id) external view returns (uint256) { ownerOf(id); return lvl[id]; }
    function setApprovalForAll(address op, bool ok) external { isApprovedForAll[msg.sender][op] = ok; emit ApprovalForAll(msg.sender, op, ok); }
    function mint(address to, uint256 n) external {
        for (uint256 i = 0; i < n; i++) {
            uint256 id = nextId++;
            owners[id] = to; lvl[id] = 1;
            emit Transfer(address(0), to, id);
        }
    }
    function transferFrom(address from, address to, uint256 id) external {
        require(owners[id] == from && (msg.sender == from || isApprovedForAll[from][msg.sender]), "not owner");
        owners[id] = to;
        emit Transfer(from, to, id);
    }
    function holderOf(uint256 id) internal view returns (address o) {
        o = ownerOf(id);
        if (o == vault) o = IVault(vault).depositorOf(id);
    }
    function merge(uint256 phase1TokenId, uint256 phase2TokenId) external {
        require(holderOf(phase1TokenId) == msg.sender && holderOf(phase2TokenId) == msg.sender, "Unauthorized");
        require(lvl[phase1TokenId] == lvl[phase2TokenId] && lvl[phase1TokenId] < 10, "InvalidMerge");
        address o = owners[phase2TokenId];
        emit Approval(o, address(0), phase2TokenId); // like an OpenZeppelin v4 burn: carries the donor id, must be ignored
        delete owners[phase2TokenId];
        delete lvl[phase2TokenId];
        emit Transfer(o, address(0), phase2TokenId);
        uint8 l = ++lvl[phase1TokenId];
        uint64 nmh = core.height() + CD[l - 1];
        emit MetadataUpdate(phase1TokenId);
        emit SqueekMerged(msg.sender, phase1TokenId, phase2TokenId, l, nmh);
    }
    function tokenURI(uint256 id) external view returns (string memory) {
        ownerOf(id);
        bytes memory hex6 = "0123456789abcdef";
        uint256 h = uint256(keccak256(abi.encode(id)));
        bytes memory c = new bytes(6);
        for (uint256 i = 0; i < 6; i++) c[i] = hex6[(h >> (i * 4)) & 15];
        string memory svg = string.concat(
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><rect width='24' height='24' fill='#f4efe2'/>",
            "<circle cx='12' cy='12' r='7' fill='#", string(c), "'/></svg>"
        );
        string memory json = string.concat(
            '{"name":"Squeek #', toString(id), '","description":"mock","image":"data:image/svg+xml;base64,', B64.encode(bytes(svg)),
            '","attributes":[{"trait_type":"Palette","value":"Mock ', string(c), '"},{"trait_type":"Body Glyph","value":"Circle"}]}'
        );
        return string.concat("data:application/json;base64,", B64.encode(bytes(json)));
    }
    function toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 n = v; uint256 len;
        while (n != 0) { len++; n /= 10; }
        bytes memory b = new bytes(len);
        while (v != 0) { b[--len] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(b);
    }
}

// Staking vault: deposit(collection, ids) pulls Squeeks in, withdraw sends them back to the depositor.
contract MockVault {
    MockSealed public nft;
    mapping(uint256 => address) public depositorOf;
    event Deposited(address indexed account, uint256 indexed tokenId);
    constructor(MockSealed n) { nft = n; }
    function deposit(address, uint256[] calldata ids) external {
        for (uint256 i = 0; i < ids.length; i++) {
            nft.transferFrom(msg.sender, address(this), ids[i]);
            depositorOf[ids[i]] = msg.sender;
            emit Deposited(msg.sender, ids[i]);
        }
    }
    function withdraw(uint256[] calldata ids) external {
        for (uint256 i = 0; i < ids.length; i++) {
            require(depositorOf[ids[i]] == msg.sender, "Unauthorized");
            delete depositorOf[ids[i]];
            nft.transferFrom(address(this), msg.sender, ids[i]);
        }
    }
}
