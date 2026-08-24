// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "../utils/ERC721.sol";
import {MerkleProof} from "../utils/MerkleProof.sol";
import {Owned} from "../utils/Owned.sol";
import {ReentrancyGuard} from "../utils/ReentrancyGuard.sol";
import {UnderwaterTrophy} from "./UnderwaterTrophy.sol";
import {IAavePool} from "./interfaces/IAavePool.sol";
import {IUnderwaterRenderer} from "./interfaces/IUnderwaterRenderer.sol";

/// @title UnderwaterPlates
/// @notice 2222 hydrographic survey plates. Each one is a live rendering of a
///         leveraged position: crisp ink at the surface, dissolving into plumes
///         as the health factor falls, gone when it liquidates.
///
/// Three properties are worth checking before you buy one, and all three are
/// verifiable by reading this file:
///
/// 1. **The trait table is pre-committed.** `provenance` is fixed in the
///    constructor and `seal` refuses to open minting unless the table written
///    to storage hashes to it. The art cannot be tuned after demand is known.
/// 2. **Trait assignment is drawn after minting closes.** `reveal` picks the
///    offset mapping plate numbers to table slots, so no minter can pick a
///    transaction position to land a rare plate.
/// 3. **Diving is opt-in and there is no custody.** A plate is an ordinary
///    tradeable NFT until its holder attaches their own position. This contract
///    never holds a token approval, never moves collateral, and reads Aave
///    read-only. It cannot liquidate anybody; it can only notice.
///
/// The cruelty is deliberate and worth stating plainly: `drown` lets a stranger
/// permanently burn a plate whose owner got liquidated, and mints them a trophy
/// engraved with the loss. That is the mechanic, not a side effect.
contract UnderwaterPlates is ERC721, Owned, ReentrancyGuard {
    // ─── Errors ───────────────────────────────────────────────────────────

    error AlreadySealed();
    error NotSealed();
    error ProvenanceMismatch();
    error OutOfRange();
    error SoldOut();
    error MintClosed();
    error WrongPayment();
    error TooManyAtOnce();
    error NotRevealed();
    error AlreadyRevealed();
    error MintStillOpen();
    error NotHolder();
    error NotDiving();
    error AlreadyDiving();
    error StillAfloat();
    error ScarTooSoon();
    error MaxScars();
    error RendererLocked();
    error ReserveTooLarge();
    error TransferFailed();
    error NotWhitelisted();
    error NoWhitelist();
    error WhitelistSoldOut();
    error PublicMintClosed();
    error WalletLimit();
    error PriceTooHigh();
    error LimitTooHigh();

    // ─── Events ───────────────────────────────────────────────────────────

    event Sealed(bytes32 provenance);
    event Revealed(uint256 offset);
    event Dived(uint256 indexed id, address indexed position);
    event Surfaced(uint256 indexed id);
    event Scarred(uint256 indexed id, uint256 scars, uint256 healthFactor);
    event Drowned(uint256 indexed id, address indexed hunter, uint256 trophyId, uint256 healthFactor);
    event RendererSet(address renderer);
    event RendererFrozen(address renderer);
    event PriceSet(uint256 price);
    event WhitelistPriceSet(uint256 price);
    event MaxPerTxSet(uint256 maxPerTx);
    event MaxPerWalletSet(uint256 maxPerWallet);
    event MerkleRootSet(bytes32 root);
    event PublicMintOpened();
    event WhitelistMinted(address indexed to, uint256 qty);

    // ─── Collection constants ─────────────────────────────────────────────

    uint256 public constant SUPPLY = 2222;

    /// @dev 10 trait categories at 4 bits each. Four bits is exactly enough:
    ///      the widest category (relic) has 15 options.
    uint256 public constant CATEGORIES = 10;
    uint256 public constant TRAIT_BITS = 4;
    uint256 public constant BITS_PER_PLATE = CATEGORIES * TRAIT_BITS; // 40
    uint256 public constant PLATES_PER_WORD = 256 / BITS_PER_PLATE; // 6
    uint256 public constant TABLE_WORDS = 371; // ceil(2222 / 6)
    // Operands are the right way round: a 40-bit mask of set bits.
    // forge-lint: disable-next-line(incorrect-shift)
    uint256 private constant PLATE_MASK = (1 << BITS_PER_PLATE) - 1;

    /// @notice Plates reservable for the allowlist phase.
    /// @dev A cap on the *phase*, not an earmark on specific plates. Whatever the
    ///      allowlist leaves unminted rolls into the public phase rather than
    ///      becoming unmintable, because plates nobody can mint would keep the
    ///      collection from ever selling out — and `reveal` waits on that or on
    ///      the deadline.
    uint256 public constant WL_ALLOCATION = 1000;

    /// @notice Ceiling on any price the owner can set, allowlist or public.
    /// @dev The prices below are settable so a dollar-denominated target can be
    ///      re-pegged as ETH moves; this is the bound that keeps "settable" from
    ///      meaning "arbitrary". It is deliberately generous — a $10 allowlist
    ///      price needs 0.02 ETH if ETH is at $500 and 0.001 ETH if it is at
    ///      $10,000 — so what it really stops is a fat-fingered extra zero.
    ///      Enforced in the constructor and in every setter, like the launchpad's
    ///      fee caps.
    uint256 public constant PRICE_CEILING = 1 ether;

    /// @notice Ceiling on `maxPerTx` and `maxPerWallet`.
    /// @dev Gas is the real limit on a batch — 222 plates in one transaction is
    ///      already several million gas — so this is a sanity bound rather than a
    ///      tuned number. 10% of the supply in a single call is past any sane
    ///      launch configuration.
    uint256 public constant LIMIT_CEILING = 222;

    /// @notice Health factor at or below which a plate can be drowned by anyone.
    uint256 public constant DROWN_HF = 1e18;

    /// @notice Health factor below which a near-death dip can be engraved.
    uint256 public constant SCAR_HF = 1.4e18;

    /// @notice Minimum spacing between two scars on the same plate.
    uint256 public constant SCAR_COOLDOWN = 1 days;

    /// @notice A plate stops accumulating scars once the paper is this marked.
    uint256 public constant MAX_SCARS = 8;

    /// @notice Health factor reported for a plate with no position attached.
    uint256 public constant DRY_DOCK = type(uint256).max;

    /// @notice Secondary royalty, in bps, reported via ERC2981.
    uint96 public constant ROYALTY_BPS = 500;

    // ─── Immutables ───────────────────────────────────────────────────────

    /// @notice keccak256 of the abi-encoded packed trait table, fixed before
    ///         any plate exists. See `seal`.
    bytes32 public immutable provenance;

    /// @notice Aave V3 pool read for health factors. Immutable on purpose: a
    ///         settable risk source would be a lever over everyone's art.
    IAavePool public immutable pool;

    /// @notice Trophy collection minted to liquidators.
    UnderwaterTrophy public immutable trophy;

    address public immutable treasury;

    /// @notice Plates minted to `treasury` at seal, before public minting.
    uint256 public immutable reserve;

    /// @notice After this timestamp `reveal` may be called even if unsold, so a
    ///         slow mint cannot strand the collection unrevealed forever.
    uint256 public immutable mintCloses;

    // ─── State ────────────────────────────────────────────────────────────

    /// @notice Public mint price per plate, in wei.
    /// @dev Settable, unlike the rest of the launch parameters. That is a real
    ///      trust concession and it is deliberate: the price targets a dollar
    ///      figure, which a fixed ETH amount cannot hold. Bounded by
    ///      `PRICE_CEILING`, and `mint` requires *exact* payment, so a price
    ///      raised under an in-flight transaction makes it revert rather than
    ///      quietly overcharging.
    uint256 public price;

    /// @notice Allowlist mint price per plate, in wei.
    uint256 public wlPrice;

    /// @notice Most plates one transaction may mint.
    uint256 public maxPerTx;

    /// @notice Most plates one address may mint in the allowlist phase.
    /// @dev Only the allowlist phase is tracked per wallet. Enforcing it in the
    ///      public phase would be theatre — a second address costs nothing — but
    ///      in the allowlist phase every address has to be in the tree, so the
    ///      limit is worth something there.
    uint256 public maxPerWallet;

    /// @notice Root of the allowlist tree. Zero means no allowlist is configured.
    bytes32 public merkleRoot;

    /// @notice Plates minted in the allowlist phase, against `WL_ALLOCATION`.
    uint256 public wlMinted;

    /// @notice Plates each address has taken from the allowlist.
    mapping(address => uint256) public wlClaimed;

    /// @notice True once the public phase is open. One-way.
    /// @dev A latch rather than a timestamp so the owner can open the public
    ///      phase when the allowlist has actually finished, and cannot close it
    ///      again to strand buyers mid-mint.
    bool public publicOpen;

    /// @notice Plates minted so far. Ids run 1..SUPPLY in mint order.
    uint256 public minted;

    /// @notice True once the trait table is committed and verified.
    bool public isSealed;

    /// @notice True once the plate-number-to-table-slot offset is drawn.
    bool public isRevealed;

    uint256 public revealOffset;

    /// @notice Renderer. Replaceable by the owner until `freezeRenderer`.
    IUnderwaterRenderer public renderer;
    bool public rendererFrozen;

    /// @notice A plate's attachment to a position, and its permanent history.
    struct Dive {
        /// @dev Position being tracked, always the holder at the time of diving.
        ///      Zero means dry dock.
        address position;
        /// @dev When the current dive began. Zero in dry dock.
        uint40 since;
        /// @dev When the last scar was engraved, for the cooldown.
        uint40 lastScar;
        /// @dev Survived near-death dips. Never reset — not by surfacing, not by
        ///      selling. The paper remembers.
        uint8 scars;
    }

    mapping(uint256 => Dive) public dives;

    uint256[TABLE_WORDS] private _table;

    constructor(
        address _owner,
        address _pool,
        address _treasury,
        bytes32 _provenance,
        uint256 _price,
        uint256 _wlPrice,
        uint256 _reserve,
        uint256 _mintCloses
    ) ERC721("Underwater", "PLATE") Owned(_owner) {
        if (_pool == address(0) || _treasury == address(0)) revert ZeroAddress();
        // A reserve large enough to matter is a rug in slow motion. 10% ceiling.
        if (_reserve > SUPPLY / 10) revert ReserveTooLarge();
        // The same bound the setters enforce, so a deploy cannot start outside
        // the range the owner is later held to.
        if (_price > PRICE_CEILING || _wlPrice > PRICE_CEILING) revert PriceTooHigh();

        pool = IAavePool(_pool);
        treasury = _treasury;
        provenance = _provenance;
        price = _price;
        wlPrice = _wlPrice;
        reserve = _reserve;
        mintCloses = _mintCloses;

        maxPerTx = 22;
        maxPerWallet = 22;

        trophy = new UnderwaterTrophy(address(this));
    }

    // ─── Trait table ──────────────────────────────────────────────────────

    /// @notice Write part of the packed trait table.
    /// @dev Batched because 371 words do not fit in one transaction's gas at a
    ///      comfortable margin. Order does not matter; `seal` is the only thing
    ///      that decides whether the result is the committed table.
    function commit(uint256 startWord, uint256[] calldata words) external onlyOwner {
        if (isSealed) revert AlreadySealed();
        if (startWord + words.length > TABLE_WORDS) revert OutOfRange();

        for (uint256 i; i < words.length; ++i) {
            _table[startWord + i] = words[i];
        }
    }

    /// @notice Verify the written table against `provenance` and open minting.
    /// @dev The check is the whole security model of the art: it proves the
    ///      2222 trait sets on chain are the ones hashed before launch, so the
    ///      rarity distribution could not have been edited in response to
    ///      demand. Fails loudly rather than sealing something else.
    function seal() external onlyOwner {
        if (isSealed) revert AlreadySealed();

        uint256[] memory flat = new uint256[](TABLE_WORDS);
        for (uint256 i; i < TABLE_WORDS; ++i) {
            flat[i] = _table[i];
        }
        if (keccak256(abi.encode(flat)) != provenance) revert ProvenanceMismatch();

        isSealed = true;
        emit Sealed(provenance);

        for (uint256 i; i < reserve; ++i) {
            _mint(treasury, ++minted);
        }
    }

    /// @notice Raw packed word `index` of the trait table.
    function tableWord(uint256 index) external view returns (uint256) {
        if (index >= TABLE_WORDS) revert OutOfRange();
        return _table[index];
    }

    /// @notice Packed trait indices for plate `id`.
    /// @dev Reverts before reveal: until the offset is drawn, no plate has a
    ///      trait set, and returning a placeholder would let callers mistake it
    ///      for one.
    function traitsOf(uint256 id) public view returns (uint256) {
        if (id == 0 || id > SUPPLY) revert OutOfRange();
        if (!isRevealed) revert NotRevealed();

        uint256 slot = (id - 1 + revealOffset) % SUPPLY;
        return (_table[slot / PLATES_PER_WORD] >> (slot % PLATES_PER_WORD * BITS_PER_PLATE)) & PLATE_MASK;
    }

    /// @notice One trait index, `category` in 0..CATEGORIES-1.
    function traitOf(uint256 id, uint256 category) external view returns (uint256) {
        if (category >= CATEGORIES) revert OutOfRange();
        // As above: `1 << TRAIT_BITS` is a 4-bit mask, not a reversed shift.
        // forge-lint: disable-next-line(incorrect-shift)
        return (traitsOf(id) >> (category * TRAIT_BITS)) & ((1 << TRAIT_BITS) - 1);
    }

    // ─── Mint ─────────────────────────────────────────────────────────────

    /// @notice Mint `qty` plates to the caller, in the public phase.
    function mint(uint256 qty) external payable nonReentrant {
        if (!publicOpen) revert PublicMintClosed();

        _takePayment(qty, price);
        _issue(qty);
    }

    /// @notice Mint `qty` plates to the caller against the allowlist.
    ///
    /// @param proof Sibling hashes proving `msg.sender` is in the tree.
    ///
    /// @dev Open as soon as the table is sealed and a root is set, and it stays
    ///      open after the public phase opens — an allowlist spot is a right to
    ///      the discounted price, and taking it away the moment the public phase
    ///      starts would punish anyone who was slow. `WL_ALLOCATION` is what
    ///      bounds it.
    function mintWhitelist(uint256 qty, bytes32[] calldata proof) external payable nonReentrant {
        bytes32 root = merkleRoot;
        // A zero root would verify an empty proof against a zero computed hash
        // for any caller, so an unconfigured allowlist must be refused here
        // rather than left to `verify`.
        if (root == bytes32(0)) revert NoWhitelist();
        if (!MerkleProof.verify(proof, root, _leaf(msg.sender))) revert NotWhitelisted();

        if (wlMinted + qty > WL_ALLOCATION) revert WhitelistSoldOut();
        uint256 taken = wlClaimed[msg.sender] + qty;
        if (taken > maxPerWallet) revert WalletLimit();

        wlMinted += qty;
        wlClaimed[msg.sender] = taken;

        _takePayment(qty, wlPrice);
        _issue(qty);

        emit WhitelistMinted(msg.sender, qty);
    }

    /// @dev The checks both phases share, and the payment. Exact payment rather
    ///      than `>=`: it makes a price change under an in-flight transaction a
    ///      revert instead of an overcharge, and it means no refund path exists to
    ///      get wrong.
    function _takePayment(uint256 qty, uint256 unit) private view {
        if (!isSealed) revert NotSealed();
        // A mint deadline is a launch parameter, not a security boundary;
        // sequencer timestamp drift of a few seconds is irrelevant here.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > mintCloses) revert MintClosed();
        if (qty == 0 || qty > maxPerTx) revert TooManyAtOnce();
        if (minted + qty > SUPPLY) revert SoldOut();
        if (msg.value != unit * qty) revert WrongPayment();
    }

    function _issue(uint256 qty) private {
        for (uint256 i; i < qty; ++i) {
            _safeMint(msg.sender, ++minted, "");
        }
    }

    /// @dev Hashed twice. An internal node in this tree is the hash of two
    ///      concatenated words, so a single-word hash can never collide with one —
    ///      which is what stops a caller presenting an internal node as their own
    ///      leaf and proving membership they were never granted. Generate the tree
    ///      off chain the same way: `keccak256(keccak256(abi.encode(address)))`.
    function _leaf(address account) private pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account))));
    }

    /// @notice Draw the offset that maps plate numbers to trait table slots.
    /// @dev Permissionless, and callable only once minting can no longer change
    ///      the outcome — either sold out or past the deadline. That ordering is
    ///      the point: a minter cannot see the offset before choosing to mint.
    ///
    ///      The offset comes from the previous block hash, which on an OP Stack
    ///      chain the sequencer can influence by reordering. It cannot be
    ///      influenced by a *minter*, which is the attack this defends against.
    ///      Anyone unwilling to trust the sequencer here should treat the
    ///      distribution as sequencer-chosen rather than random.
    function reveal() external {
        if (isRevealed) revert AlreadyRevealed();
        if (!isSealed) revert NotSealed();
        // forge-lint: disable-next-line(block-timestamp)
        if (minted < SUPPLY && block.timestamp <= mintCloses) revert MintStillOpen();

        isRevealed = true;
        revealOffset = uint256(blockhash(block.number - 1)) % SUPPLY;
        emit Revealed(revealOffset);
    }

    /// @notice Forward mint proceeds to `treasury`.
    /// @dev Permissionless and hardcoded to `treasury`, so it is a plumbing
    ///      call rather than an owner privilege. Nobody can redirect it.
    function withdraw() external {
        uint256 balance = address(this).balance;
        (bool ok,) = treasury.call{value: balance}("");
        if (!ok) revert TransferFailed();
    }

    // ─── Diving ───────────────────────────────────────────────────────────

    /// @notice Attach the caller's own Aave position to a plate they hold.
    /// @dev The tracked address is always `msg.sender` and never a parameter.
    ///      Letting a holder point a plate at a stranger's position would mean
    ///      `drown` burns art over a loss its owner never took.
    function dive(uint256 id) external {
        if (ownerOf(id) != msg.sender) revert NotHolder();
        if (dives[id].position != address(0)) revert AlreadyDiving();

        dives[id].position = msg.sender;
        // forge-lint: disable-next-line(block-timestamp)
        dives[id].since = uint40(block.timestamp);
        emit Dived(id, msg.sender);
    }

    /// @notice Detach the position. Scars already engraved stay.
    function surface(uint256 id) external {
        if (ownerOf(id) != msg.sender) revert NotHolder();
        if (dives[id].position == address(0)) revert NotDiving();

        _surface(id);
    }

    /// @notice Health factor driving a plate's art, 1e18-scaled.
    /// @return `DRY_DOCK` when no position is attached, which is also what Aave
    ///         reports for an attached position carrying no debt.
    function healthFactorOf(uint256 id) public view returns (uint256) {
        address position = dives[id].position;
        if (position == address(0)) return DRY_DOCK;

        (,,,,, uint256 hf) = pool.getUserAccountData(position);
        return hf;
    }

    /// @notice Engrave a near-death dip on a plate currently below `SCAR_HF`.
    /// @dev Permissionless: a scar is a public record of how close a position
    ///      came, and the holder is the last person who should get to decide
    ///      whether it counts. Rate-limited per plate and capped so it cannot be
    ///      used to grind a plate's paper to noise.
    function scar(uint256 id) external {
        ownerOf(id); // reverts NotMinted for a plate that does not exist
        Dive storage d = dives[id];
        if (d.position == address(0)) revert NotDiving();
        if (d.scars >= MAX_SCARS) revert MaxScars();

        uint256 hf = healthFactorOf(id);
        if (hf >= SCAR_HF) revert StillAfloat();
        // forge-lint: disable-next-line(block-timestamp)
        if (d.lastScar != 0 && block.timestamp < d.lastScar + SCAR_COOLDOWN) revert ScarTooSoon();

        // forge-lint: disable-next-line(block-timestamp)
        d.lastScar = uint40(block.timestamp);
        emit Scarred(id, ++d.scars, hf);
    }

    /// @notice Burn a plate whose position has crossed liquidation, and take the
    ///         engraved trophy.
    /// @dev Permissionless by design. Checks the health factor on-chain against
    ///      the same Aave pool the art reads, so a kill cannot be claimed on a
    ///      position that is still solvent.
    function drown(uint256 id) external nonReentrant returns (uint256 trophyId) {
        ownerOf(id);
        if (dives[id].position == address(0)) revert NotDiving();

        uint256 hf = healthFactorOf(id);
        if (hf > DROWN_HF) revert StillAfloat();

        _burn(id);
        // `ownerOf` above proves this plate was minted, so id <= SUPPLY = 2222.
        // forge-lint: disable-next-line(unsafe-typecast)
        trophyId = trophy.record(uint16(id), msg.sender, hf);
        emit Drowned(id, msg.sender, trophyId, hf);
    }

    // ─── Metadata ─────────────────────────────────────────────────────────

    function tokenURI(uint256 id) public view override returns (string memory) {
        ownerOf(id);
        return
            renderer.render(
                id, isRevealed ? traitsOf(id) : 0, healthFactorOf(id), dives[id].scars, isRevealed
            );
    }

    /// @notice ERC2981. A flat rate to `treasury` for every plate.
    function royaltyInfo(uint256, uint256 salePrice) external view returns (address, uint256) {
        return (treasury, salePrice * ROYALTY_BPS / 10_000);
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == 0x2a55205a // ERC2981
            || super.supportsInterface(interfaceId);
    }

    // ─── Owner ────────────────────────────────────────────────────────────

    /// @notice Point the collection at a renderer.
    /// @dev Exists because SVG filter support across marketplaces is inconsistent
    ///      enough that shipping art with no way to fix a rendering bug would be
    ///      the more reckless choice. `freezeRenderer` gives it up permanently.
    function setRenderer(address _renderer) external onlyOwner {
        if (rendererFrozen) revert RendererLocked();
        if (_renderer == address(0)) revert ZeroAddress();

        renderer = IUnderwaterRenderer(_renderer);
        emit RendererSet(_renderer);
    }

    /// @notice Set the public mint price, in wei.
    /// @dev Bounded by `PRICE_CEILING`. Zero is allowed on purpose — a free public
    ///      phase is a legitimate launch choice, and forbidding it here would be
    ///      an opinion, not a safety property.
    function setPrice(uint256 _price) external onlyOwner {
        if (_price > PRICE_CEILING) revert PriceTooHigh();

        price = _price;
        emit PriceSet(_price);
    }

    /// @notice Set the allowlist mint price, in wei.
    /// @dev Separate from `setPrice` rather than one call taking both, so
    ///      re-pegging one phase cannot silently move the other.
    function setWhitelistPrice(uint256 _wlPrice) external onlyOwner {
        if (_wlPrice > PRICE_CEILING) revert PriceTooHigh();

        wlPrice = _wlPrice;
        emit WhitelistPriceSet(_wlPrice);
    }

    /// @notice Set the most plates one transaction may mint.
    function setMaxPerTx(uint256 _maxPerTx) external onlyOwner {
        if (_maxPerTx == 0 || _maxPerTx > LIMIT_CEILING) revert LimitTooHigh();

        maxPerTx = _maxPerTx;
        emit MaxPerTxSet(_maxPerTx);
    }

    /// @notice Set the most plates one address may take from the allowlist.
    /// @dev Lowering this does not claw back plates already minted; it only binds
    ///      further mints. An address already over a new, lower limit simply
    ///      cannot mint again.
    function setMaxPerWallet(uint256 _maxPerWallet) external onlyOwner {
        if (_maxPerWallet == 0 || _maxPerWallet > LIMIT_CEILING) revert LimitTooHigh();

        maxPerWallet = _maxPerWallet;
        emit MaxPerWalletSet(_maxPerWallet);
    }

    /// @notice Set the allowlist root.
    /// @dev Replaceable, so a spot can be added or a mistake corrected before the
    ///      phase runs. It cannot retroactively unmint anybody: `wlClaimed`
    ///      survives a root change, so removing an address does not restore the
    ///      plates it already took.
    function setMerkleRoot(bytes32 root) external onlyOwner {
        merkleRoot = root;
        emit MerkleRootSet(root);
    }

    /// @notice Open the public phase. One-way.
    /// @dev No matching close: buyers part-way through a mint should not have the
    ///      phase shut under them, and "sold out" is what ends it.
    function openPublicMint() external onlyOwner {
        publicOpen = true;
        emit PublicMintOpened();
    }

    /// @notice Give up the ability to change the renderer, forever.
    function freezeRenderer() external onlyOwner {
        if (address(renderer) == address(0)) revert ZeroAddress();
        rendererFrozen = true;
        emit RendererFrozen(address(renderer));
    }

    // ─── Internal ─────────────────────────────────────────────────────────

    /// @dev A plate surfaces when it changes hands or is burned. The position
    ///      belonged to the previous holder, and leaving it attached would let
    ///      a seller drown a plate they no longer own by letting their own
    ///      position go bad.
    function _afterTokenTransfer(address from, address, uint256 id) internal override {
        if (from != address(0) && dives[id].position != address(0)) _surface(id);
    }

    function _surface(uint256 id) private {
        dives[id].position = address(0);
        dives[id].since = 0;
        emit Surfaced(id);
    }
}
