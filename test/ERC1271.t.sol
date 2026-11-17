// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test, console} from "forge-std/Test.sol";
import {PasskeyAccount, PackedUserOperation} from "../src/PasskeyAccount.sol";
import {WebAuthn} from "../src/WebAuthn.sol";
import {Vectors} from "./Vectors.sol";

contract ERC1271Test is Test, Vectors {
    PasskeyAccount account;
    address constant ENTRYPOINT = address(0xE);
    uint256 constant THRESHOLD = 1 ether;

    bytes32 constant MSG_HASH = keccak256("Sign in to Uniswap");
    bytes4 constant MAGICVALUE = 0x1626ba7e;
    bytes4 constant INVALID = 0xffffffff;

    uint256 constant P256_N =
        0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;

    // Generated P-256 keys specifically for this test fixture
    uint256 constant K0_X_1271 =
        0x468bab0ff974d389f9b43224a1538c8857a3b9b4fb180940ffa871b2efef8c3c;
    uint256 constant K0_Y_1271 =
        0x007e0b1f166c0161be4b8bf91e6816bbf743c23c763533826137d3fc07e3794d;

    uint256 constant K1_X_1271 =
        0xfd0af757882a1f0d12922f98ee154ad185bcd93e053d864e240b11fbb8858821;
    uint256 constant K1_Y_1271 =
        0x614087a02815c234d48fb4f442239f55f07b53c8bf5975eb679367b958f2a723;

    function _sig0() internal pure returns (WebAuthn.Signature memory) {
        return WebAuthn.Signature({
            authenticatorData: hex"00000000000000000000000000000000000000000000000000000000000000000500000000",
            clientDataJSON: '{"type":"webauthn.get","challenge":"3v9Yi0o1kA9ccZ-pdnD8ajSoSxJ7mwFMojLD113RHck","origin":"https://localhost:5173"}',
            challengeIndex: 23,
            typeIndex: 1,
            r: 0x35ab5a4cc110e7967600219522b8be4173da84ad93e3a3001716dda588f7dfe9,
            s: 0x666e1a6de8f529024c9f789fc096ee75843ceca348844046eaa0adfbee70754c
        });
    }

    function _sig1() internal pure returns (WebAuthn.Signature memory) {
        return WebAuthn.Signature({
            authenticatorData: hex"00000000000000000000000000000000000000000000000000000000000000000500000000",
            clientDataJSON: '{"type":"webauthn.get","challenge":"3v9Yi0o1kA9ccZ-pdnD8ajSoSxJ7mwFMojLD113RHck","origin":"https://localhost:5173"}',
            challengeIndex: 23,
            typeIndex: 1,
            r: 0x072e2665767c23a65eaf25e65974a428de7270dc13223227ff6f3f34761f654f,
            s: 0x2504e3684b360616c7685ddab8c7232bd121535e1d2418ddf181408959a9902a
        });
    }

    function setUp() public {
        account = new PasskeyAccount(
            ENTRYPOINT,
            _signers2(K0_X_1271, K0_Y_1271, K1_X_1271, K1_Y_1271),
            THRESHOLD
        );
    }

    // --- Signature payload helpers --------------------------------------------

    function _both() internal pure returns (bytes memory) {
        uint256[] memory ids = new uint256[](2);
        WebAuthn.Signature[] memory sigs = new WebAuthn.Signature[](2);
        ids[1] = 1;
        sigs[0] = _sig0();
        sigs[1] = _sig1();
        return abi.encode(ids, sigs, bytes(""));
    }

    function _one(uint256 id, WebAuthn.Signature memory sig, bytes memory personal) internal pure returns (bytes memory) {
        uint256[] memory ids = new uint256[](1);
        WebAuthn.Signature[] memory sigs = new WebAuthn.Signature[](1);
        ids[0] = id;
        sigs[0] = sig;
        return abi.encode(ids, sigs, personal);
    }

    // --- Any hash: both keys ----------------------------------------------------

    /// Both keys over the EIP-712 wrapped digest return the ERC-1271 magic value.
    function test_ERC1271_BothKeys_ReturnsMagicValue() public view {
        assertEq(account.isValidSignature(MSG_HASH, _both()), MAGICVALUE, "both keys must be accepted");
    }

    /// One key over a hash with no personal_sign proof is refused. This is the hole the
    /// rule closes: a signed permit must not need fewer keys than an on-chain approval.
    function test_Attack_ERC1271_OneKey_ArbitraryHash_Rejected() public view {
        assertEq(account.isValidSignature(MSG_HASH, _one(0, _sig0(), "")), INVALID, "key 0 alone must fail");
        assertEq(account.isValidSignature(MSG_HASH, _one(1, _sig1(), "")), INVALID, "key 1 alone must fail");
    }

    /// The same key twice is not two keys.
    function test_Attack_ERC1271_SameKeyTwice_Rejected() public view {
        uint256[] memory ids = new uint256[](2);
        WebAuthn.Signature[] memory sigs = new WebAuthn.Signature[](2);
        sigs[0] = _sig0();
        sigs[1] = _sig0();
        assertEq(account.isValidSignature(MSG_HASH, abi.encode(ids, sigs, bytes(""))), INVALID, "duplicate key must fail");
    }

    /// Mismatched id and signature counts are refused.
    function test_Attack_ERC1271_CountMismatch_Rejected() public view {
        uint256[] memory ids = new uint256[](2);
        WebAuthn.Signature[] memory sigs = new WebAuthn.Signature[](1);
        ids[1] = 1;
        sigs[0] = _sig0();
        assertEq(account.isValidSignature(MSG_HASH, abi.encode(ids, sigs, bytes(""))), INVALID, "count mismatch must fail");
    }

    /// Malleated high-s signature is strictly rejected.
    function test_Attack_ERC1271_HighS_Rejected() public view {
        uint256[] memory ids = new uint256[](2);
        WebAuthn.Signature[] memory sigs = new WebAuthn.Signature[](2);
        ids[1] = 1;
        sigs[0] = _sig0();
        sigs[1] = _sig1();
        sigs[0].s = P256_N - sigs[0].s; // high-s twin
        assertEq(account.isValidSignature(MSG_HASH, abi.encode(ids, sigs, bytes(""))), INVALID, "high-s must fail");
    }

    /// Valid signatures for a different message hash fail.
    function test_Attack_ERC1271_WrongChallenge_Rejected() public view {
        assertEq(account.isValidSignature(keccak256("Sign in to Malicious dApp"), _both()), INVALID, "other hash must fail");
    }

    /// Signer id out of range (>= signerCount) fails.
    function test_Attack_ERC1271_WrongSignerId_Rejected() public view {
        assertEq(account.isValidSignature(MSG_HASH, _one(99, _sig0(), "")), INVALID, "unknown signer must fail");
    }

    /// The old single-key encoding (uint256, Signature) is no longer accepted.
    function test_Attack_ERC1271_OldEncoding_Rejected() public {
        bytes memory old = abi.encode(uint256(0), _sig0());
        try account.isValidSignature(MSG_HASH, old) returns (bytes4 result) {
            assertEq(result, INVALID, "old encoding must fail");
        } catch {
            // A revert on malformed encoding also rejects it.
        }
    }

    // --- personal_sign: one key, with proof ---------------------------------------

    uint256 constant PK0 = 0xA11CE;
    uint256 constant PK1 = 0xB0B;

    function _freshAccount() internal returns (PasskeyAccount a) {
        (uint256 x0, uint256 y0) = vm.publicKeyP256(PK0);
        (uint256 x1, uint256 y1) = vm.publicKeyP256(PK1);
        a = new PasskeyAccount(ENTRYPOINT, _signers2(x0, y0, x1, y1), THRESHOLD);
    }

    function _b64url(bytes32 data) internal pure returns (string memory) {
        bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        bytes memory out = new bytes(43);
        uint256 v = uint256(data);
        // 32 bytes = 256 bits: 42 full sextets, then the last 4 bits shifted up.
        for (uint256 i = 0; i < 42; i++) {
            out[i] = table[(v >> (250 - i * 6)) & 63];
        }
        out[42] = table[(v & 15) << 2];
        return string(out);
    }

    /// A real assertion from a test key: the same shape a passkey returns.
    function _assert(uint256 pk, bytes32 challenge) internal pure returns (WebAuthn.Signature memory sig) {
        bytes memory authData = abi.encodePacked(bytes32(0), bytes1(0x05), bytes4(0));
        string memory cd = string.concat('{"type":"webauthn.get","challenge":"', _b64url(challenge), '","origin":"https://haptix.test"}');
        bytes32 digest = sha256(abi.encodePacked(authData, sha256(bytes(cd))));
        (bytes32 r, bytes32 s) = vm.signP256(pk, digest);
        uint256 low = uint256(s) > P256_N / 2 ? P256_N - uint256(s) : uint256(s);
        sig = WebAuthn.Signature({authenticatorData: authData, clientDataJSON: cd, challengeIndex: 23, typeIndex: 1, r: uint256(r), s: low});
    }

    function _personal(string memory text) internal pure returns (bytes memory) {
        return abi.encodePacked("\x19Ethereum Signed Message:\n", vm.toString(bytes(text).length), text);
    }

    /// A personal_sign message with its preimage needs one key: either key will do.
    function test_ERC1271_PersonalSign_OneKey_ReturnsMagicValue() public {
        PasskeyAccount a = _freshAccount();
        bytes memory preimage = _personal("Sign in to haptix.test");
        bytes32 hash = keccak256(preimage);
        bytes32 digest = a.getMessageHash(hash);
        assertEq(a.isValidSignature(hash, _one(0, _assert(PK0, digest), preimage)), MAGICVALUE, "key 0 signs in");
        assertEq(a.isValidSignature(hash, _one(1, _assert(PK1, digest), preimage)), MAGICVALUE, "key 1 signs in");
    }

    /// A personal_sign preimage for a different hash buys nothing.
    function test_Attack_PersonalSign_PreimageForOtherHash_Rejected() public {
        PasskeyAccount a = _freshAccount();
        bytes32 permitHash = keccak256("an EIP-712 digest for a permit");
        WebAuthn.Signature memory sig = _assert(PK0, a.getMessageHash(permitHash));
        assertEq(a.isValidSignature(permitHash, _one(0, sig, _personal("harmless"))), INVALID, "mismatched preimage must fail");
    }

    /// An EIP-712 preimage (0x1901...) with a correct hash still needs both keys.
    function test_Attack_TypedDataPreimage_OneKey_Rejected() public {
        PasskeyAccount a = _freshAccount();
        bytes memory preimage = abi.encodePacked(hex"1901", keccak256("domain"), keccak256("permit struct"));
        bytes32 hash = keccak256(preimage);
        WebAuthn.Signature memory sig = _assert(PK0, a.getMessageHash(hash));
        assertEq(a.isValidSignature(hash, _one(0, sig, preimage)), INVALID, "typed data needs both keys");
    }

    /// A preimage shorter than the prefix can't pass as personal_sign.
    function test_Attack_ShortPreimage_OneKey_Rejected() public {
        PasskeyAccount a = _freshAccount();
        bytes memory preimage = hex"19";
        bytes32 hash = keccak256(preimage);
        WebAuthn.Signature memory sig = _assert(PK0, a.getMessageHash(hash));
        assertEq(a.isValidSignature(hash, _one(0, sig, preimage)), INVALID, "short preimage must fail");
    }

    /// While frozen, even personal_sign needs both keys: a key may be in the wrong hands.
    function test_Frozen_PersonalSign_NeedsBothKeys() public {
        PasskeyAccount a = _freshAccount();
        bytes memory preimage = _personal("Sign in to haptix.test");
        bytes32 hash = keccak256(preimage);
        bytes32 digest = a.getMessageHash(hash);
        vm.prank(ENTRYPOINT);
        a.freeze();
        assertEq(a.isValidSignature(hash, _one(0, _assert(PK0, digest), preimage)), INVALID, "one key must fail while frozen");

        uint256[] memory ids = new uint256[](2);
        WebAuthn.Signature[] memory sigs = new WebAuthn.Signature[](2);
        ids[1] = 1;
        sigs[0] = _assert(PK0, digest);
        sigs[1] = _assert(PK1, digest);
        assertEq(a.isValidSignature(hash, abi.encode(ids, sigs, preimage)), MAGICVALUE, "both keys still work");
    }

    /// The wallet detects the new signature format from this constant.
    function test_ERC1271_VersionIsExposed() public view {
        assertEq(account.ERC1271_VERSION(), 2);
    }

    /// UserOp signature encoding (uint256[], Signature[]) is safely rejected by 1271.
    function test_Attack_ERC1271_UserOpEncoding_Rejected() public {
        uint256[] memory ids = new uint256[](1);
        WebAuthn.Signature[] memory sigs = new WebAuthn.Signature[](1);
        ids[0] = 0;
        sigs[0] = _sig0();

        bytes memory userOpSig = abi.encode(ids, sigs);
        try account.isValidSignature(MSG_HASH, userOpSig) returns (bytes4 result) {
            assertEq(result, INVALID, "userOp encoding must be rejected in 1271");
        } catch {
            // Revert on invalid abi decoding also rejects the signature
        }
    }

    /// Replaying a valid UserOp signature as an ERC-1271 signature fails.
    function test_Attack_ReplayUserOpSignatureAs1271_Rejected() public {
        // _v_small_k0 is a real UserOp vector from Vectors.sol
        bytes memory userOpSig = _one(0, _v_small_k0(), "");
        try account.isValidSignature(MSG_HASH, userOpSig) returns (bytes4 result) {
            assertEq(result, INVALID, "UserOp signature challenge does not match 1271 digest");
        } catch {
            // Revert on malformed encoding also rejects
        }
    }

    /// Replaying a valid ERC-1271 signature as a UserOp signature fails validation.
    function test_Attack_Replay1271SignatureAsUserOp_Rejected() public {
        PackedUserOperation memory op;
        op.sender = address(account);
        op.callData = abi.encodeCall(
            PasskeyAccount.execute, (address(0xBEEF), 0.001 ether, "")
        );
        // Pack 1271 signature as UserOp signature
        op.signature = abi.encode(uint256(0), _sig0());

        vm.prank(ENTRYPOINT);
        try account.validateUserOp(op, MSG_HASH, 0) returns (uint256 r) {
            assertEq(r, 1, "1271 signature payload cannot validate UserOp");
        } catch {
            // Revert in validation causes EntryPoint to fail UserOp
        }
    }

    /// Domain separator binds block.chainid and verifyingContract address.
    function test_Policy_DomainSeparator_BindsChainIdAndContract() public {
        bytes32 dsOriginal = account.domainSeparator();

        // Chain change
        vm.chainId(84532);
        bytes32 dsNewChain = account.domainSeparator();
        assertTrue(dsOriginal != dsNewChain, "domain separator must differ across chains");

        // Contract address change
        vm.chainId(31337);
        PasskeyAccount otherAccount = new PasskeyAccount(
            ENTRYPOINT,
            _signers2(K0_X_1271, K0_Y_1271, K1_X_1271, K1_Y_1271),
            THRESHOLD
        );
        assertTrue(dsOriginal != otherAccount.domainSeparator(), "domain separator must differ across accounts");
    }
}
