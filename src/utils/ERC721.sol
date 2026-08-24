// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal ERC721 with enumerable-free bookkeeping and a transfer hook.
/// @dev Written self-contained for the same reason as [ERC20](./ERC20.sol): a
///      freshly cloned repo compiles with no `forge install`, and nothing
///      outside this repo sits in the trust path of the collection.
///
///      Deliberately omits ERC721Enumerable. `tokenOfOwnerByIndex` costs a
///      write on every transfer to serve a query that indexers answer for free,
///      and the collection is a fixed 2222 — anyone can enumerate by scanning.
abstract contract ERC721 {
    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event Approval(address indexed owner, address indexed spender, uint256 indexed id);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    error NotMinted();
    error ZeroRecipient();
    error AlreadyMinted();
    error WrongFrom();
    error NotAuthorized();
    error UnsafeRecipient();

    string public name;
    string public symbol;

    mapping(uint256 => address) internal _ownerOf;
    mapping(address => uint256) internal _balanceOf;

    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    constructor(string memory _name, string memory _symbol) {
        name = _name;
        symbol = _symbol;
    }

    function tokenURI(uint256 id) public view virtual returns (string memory);

    // ─── Views ────────────────────────────────────────────────────────────

    function ownerOf(uint256 id) public view virtual returns (address owner) {
        owner = _ownerOf[id];
        if (owner == address(0)) revert NotMinted();
    }

    function balanceOf(address owner) public view virtual returns (uint256) {
        if (owner == address(0)) revert ZeroRecipient();
        return _balanceOf[owner];
    }

    function supportsInterface(bytes4 interfaceId) public view virtual returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC165
            || interfaceId == 0x80ac58cd // ERC721
            || interfaceId == 0x5b5e139f; // ERC721Metadata
    }

    // ─── Transfers ────────────────────────────────────────────────────────

    function approve(address spender, uint256 id) public virtual {
        address owner = _ownerOf[id];
        if (msg.sender != owner && !isApprovedForAll[owner][msg.sender]) revert NotAuthorized();

        getApproved[id] = spender;
        emit Approval(owner, spender, id);
    }

    function setApprovalForAll(address operator, bool approved) public virtual {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 id) public virtual {
        if (from != _ownerOf[id]) revert WrongFrom();
        if (to == address(0)) revert ZeroRecipient();
        if (msg.sender != from && !isApprovedForAll[from][msg.sender] && msg.sender != getApproved[id]) {
            revert NotAuthorized();
        }

        // Cannot underflow or overflow: `from` provably holds this token, and
        // total supply is bounded far below type(uint256).max.
        unchecked {
            _balanceOf[from]--;
            _balanceOf[to]++;
        }

        _ownerOf[id] = to;
        delete getApproved[id];

        emit Transfer(from, to, id);
        _afterTokenTransfer(from, to, id);
    }

    function safeTransferFrom(address from, address to, uint256 id) public virtual {
        safeTransferFrom(from, to, id, "");
    }

    function safeTransferFrom(address from, address to, uint256 id, bytes memory data) public virtual {
        transferFrom(from, to, id);
        _checkRecipient(from, to, id, data);
    }

    // ─── Internal mint / burn ─────────────────────────────────────────────

    function _mint(address to, uint256 id) internal virtual {
        if (to == address(0)) revert ZeroRecipient();
        if (_ownerOf[id] != address(0)) revert AlreadyMinted();

        unchecked {
            _balanceOf[to]++;
        }
        _ownerOf[id] = to;

        emit Transfer(address(0), to, id);
        _afterTokenTransfer(address(0), to, id);
    }

    function _safeMint(address to, uint256 id, bytes memory data) internal virtual {
        _mint(to, id);
        _checkRecipient(address(0), to, id, data);
    }

    function _burn(uint256 id) internal virtual {
        address owner = _ownerOf[id];
        if (owner == address(0)) revert NotMinted();

        unchecked {
            _balanceOf[owner]--;
        }
        delete _ownerOf[id];
        delete getApproved[id];

        emit Transfer(owner, address(0), id);
        _afterTokenTransfer(owner, address(0), id);
    }

    /// @dev Called after every mint, transfer and burn. Mint passes
    ///      `from == address(0)`, burn passes `to == address(0)`.
    function _afterTokenTransfer(address from, address to, uint256 id) internal virtual {}

    function _checkRecipient(address from, address to, uint256 id, bytes memory data) private {
        if (to.code.length == 0) return;
        if (ERC721TokenReceiver(to).onERC721Received(msg.sender, from, id, data) != 0x150b7a02) {
            revert UnsafeRecipient();
        }
    }
}

/// @notice Callback interface for contracts receiving a safe transfer.
interface ERC721TokenReceiver {
    function onERC721Received(address operator, address from, uint256 id, bytes calldata data)
        external
        returns (bytes4);
}
