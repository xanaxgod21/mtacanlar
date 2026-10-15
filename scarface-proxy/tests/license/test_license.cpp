#include <algorithm>
#include <array>
#include <cstdint>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <fmt/format.h>
#include <gtest/gtest.h>
#include "license/license.hpp"

using namespace license;

namespace {
struct Vector {
    std::string_view payload;   // Hex of the payload JSON.
    std::string_view signature; // Hex of its Ed25519 signature.
};

// Generated with Python's cryptography package, signed with the Ed25519 key
// from the seed 000102...1f (OTHER_PUBLIC_KEY: seed 202122...3f). Payloads are
// serialized like the key server does it:
// json.dumps(obj, separators=(",", ":"), sort_keys=True, ensure_ascii=True)
constexpr std::string_view NONCE{ "00112233445566778899aabbccddeeff" };
constexpr std::string_view HWID{ "0123456789ABCDEF0123456789ABCDEF" };
constexpr std::int64_t SERVER_TIME{ 1760000000 };

constexpr std::string_view PUBLIC_KEY{ "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8" };
constexpr std::string_view OTHER_PUBLIC_KEY{ "29acbae141bccaf0b22e1a94d34d0bc7361e526d0bfe12c89794bc9322966dd7" };

// {"expires_at":1800000000,"hwid":"0123456789ABCDEF0123456789ABCDEF","message":"License is valid","nonce":"00112233445566778899aabbccddeeff","server_time":1760000000,"status":"ok","v":1}
constexpr Vector OK{
    "7b22657870697265735f6174223a313830303030303030302c2268776964223a223031323334353637383941424344454630313233343536373839414243444546222c226d657373616765223a224c6963656e73652069732076616c6964222c226e6f6e6365223a223030313132323333343435353636373738383939616162626363646465656666222c227365727665725f74696d65223a313736303030303030302c22737461747573223a226f6b222c2276223a317d",
    "fdf070c0688325d95fa123cb91843da227a12eaf2788ec545d74ce39f8382b91d7e235f3e1c07bae2f7b24a63f4675bba7a9615b18d6552b622e2e3edf953002"
};

// {"expires_at":0,"hwid":"0123456789ABCDEF0123456789ABCDEF","message":"License is valid","nonce":"00112233445566778899aabbccddeeff","server_time":1760000000,"status":"ok","v":1}
constexpr Vector OK_LIFETIME{
    "7b22657870697265735f6174223a302c2268776964223a223031323334353637383941424344454630313233343536373839414243444546222c226d657373616765223a224c6963656e73652069732076616c6964222c226e6f6e6365223a223030313132323333343435353636373738383939616162626363646465656666222c227365727665725f74696d65223a313736303030303030302c22737461747573223a226f6b222c2276223a317d",
    "bfd2ad00a7b2e336837dfbc8c61b15fb12586afd6429c9a759e015a30391d36c7790ae87a2280d4271bd200a63f9277110fe41cfc3f4d2cb224504474812e408"
};

// {"expires_at":1760000000,"hwid":"0123456789ABCDEF0123456789ABCDEF","message":"License is valid","nonce":"00112233445566778899aabbccddeeff","server_time":1760000000,"status":"ok","v":1}
constexpr Vector OK_EXPIRES_NOW{
    "7b22657870697265735f6174223a313736303030303030302c2268776964223a223031323334353637383941424344454630313233343536373839414243444546222c226d657373616765223a224c6963656e73652069732076616c6964222c226e6f6e6365223a223030313132323333343435353636373738383939616162626363646465656666222c227365727665725f74696d65223a313736303030303030302c22737461747573223a226f6b222c2276223a317d",
    "71ad940045d03fd5a5950fb29e70e0ad96edd9bc63290366b3cef478b3a57c91095462d20b48e225d196b069c78fc4f9ece9d6c00fac618b3097dc913ea71901"
};

// {"expires_at":0,"hwid":"0123456789abcdef0123456789abcdef","message":"License is valid","nonce":"00112233445566778899aabbccddeeff","server_time":1760000000,"status":"ok","v":1}
constexpr Vector OK_LOWERCASE_HWID{
    "7b22657870697265735f6174223a302c2268776964223a223031323334353637383961626364656630313233343536373839616263646566222c226d657373616765223a224c6963656e73652069732076616c6964222c226e6f6e6365223a223030313132323333343435353636373738383939616162626363646465656666222c227365727665725f74696d65223a313736303030303030302c22737461747573223a226f6b222c2276223a317d",
    "e3d97c204b61b0448454a485d1c453d2b9d6bc41c382b07f608fa591520e6b2bbbbf62f3fb63be2ab9d1aeeea9959eefec9ebe63de339f63e1ba7806a8a1b309"
};

// {"expires_at":0,"hwid":"0123456789ABCDEF0123456789ABCDEF","message":"Unknown license key","nonce":"00112233445566778899aabbccddeeff","server_time":1760000000,"status":"invalid_key","v":1}
constexpr Vector INVALID_KEY{
    "7b22657870697265735f6174223a302c2268776964223a223031323334353637383941424344454630313233343536373839414243444546222c226d657373616765223a22556e6b6e6f776e206c6963656e7365206b6579222c226e6f6e6365223a223030313132323333343435353636373738383939616162626363646465656666222c227365727665725f74696d65223a313736303030303030302c22737461747573223a22696e76616c69645f6b6579222c2276223a317d",
    "8a4e6257bbb5bb882bc3bcbee1338621052fa0de4b59787ae11cedf115fd40647e4693795c95c4a7a0e3d2bf674ece1a29fdf35afc1c8c693b47deed7dc8150b"
};

// {"expires_at":1800000000,"hwid":"0123456789ABCDEF0123456789ABCDEF","message":"License key has been revoked","nonce":"00112233445566778899aabbccddeeff","server_time":1760000000,"status":"revoked","v":1}
constexpr Vector REVOKED{
    "7b22657870697265735f6174223a313830303030303030302c2268776964223a223031323334353637383941424344454630313233343536373839414243444546222c226d657373616765223a224c6963656e7365206b657920686173206265656e207265766f6b6564222c226e6f6e6365223a223030313132323333343435353636373738383939616162626363646465656666222c227365727665725f74696d65223a313736303030303030302c22737461747573223a227265766f6b6564222c2276223a317d",
    "7fcf2be88474e7e1760d1f6f222c0fe563d2b9ca9498843768ba5d12a180a1965da81e23df7df39ce94f65d8d474743f6dff5385469234ae656a6970d275ac03"
};

// {"expires_at":1750000000,"hwid":"0123456789ABCDEF0123456789ABCDEF","message":"License key has expired","nonce":"00112233445566778899aabbccddeeff","server_time":1760000000,"status":"expired","v":1}
constexpr Vector EXPIRED{
    "7b22657870697265735f6174223a313735303030303030302c2268776964223a223031323334353637383941424344454630313233343536373839414243444546222c226d657373616765223a224c6963656e7365206b6579206861732065787069726564222c226e6f6e6365223a223030313132323333343435353636373738383939616162626363646465656666222c227365727665725f74696d65223a313736303030303030302c22737461747573223a2265787069726564222c2276223a317d",
    "a187694a1da0acbeb082918d4872e4982ede52a35c8d65d1c9f33982382a56e022d2147ab52f9bbf303719a43a1ba7ff5cdb2fb36f0b392da211a96a39603e0b"
};

// {"expires_at":1800000000,"hwid":"0123456789ABCDEF0123456789ABCDEF","message":"License key is bound to another computer","nonce":"00112233445566778899aabbccddeeff","server_time":1760000000,"status":"hwid_mismatch","v":1}
constexpr Vector HWID_MISMATCH{
    "7b22657870697265735f6174223a313830303030303030302c2268776964223a223031323334353637383941424344454630313233343536373839414243444546222c226d657373616765223a224c6963656e7365206b657920697320626f756e6420746f20616e6f7468657220636f6d7075746572222c226e6f6e6365223a223030313132323333343435353636373738383939616162626363646465656666222c227365727665725f74696d65223a313736303030303030302c22737461747573223a22687769645f6d69736d61746368222c2276223a317d",
    "5f9b0597183bc858650168a339dc1dd6691868b465dbf7f99d87b58b1a7410cd91071b3f2bce07ec4c1b28e0b393c7fa3aa8e3445fed9ecb61597cd2bb35c001"
};

// {"expires_at":0,"hwid":"0123456789ABCDEF0123456789ABCDEF","message":"?","nonce":"00112233445566778899aabbccddeeff","server_time":1760000000,"status":"suspended","v":1}
constexpr Vector UNKNOWN_STATUS{
    "7b22657870697265735f6174223a302c2268776964223a223031323334353637383941424344454630313233343536373839414243444546222c226d657373616765223a223f222c226e6f6e6365223a223030313132323333343435353636373738383939616162626363646465656666222c227365727665725f74696d65223a313736303030303030302c22737461747573223a2273757370656e646564222c2276223a317d",
    "0b71ec4187b0de03b4f03d74239f3898a52fcf8b78e64e9535276aff08550a34a54368142e35c0cd19af42e7f188664762f75801e12babd67831ceaac2786304"
};

// {"expires_at":0,"hwid":"0123456789ABCDEF0123456789ABCDEF","message":"License is valid","nonce":"00112233445566778899aabbccddeeff","server_time":1760000000,"status":"ok","v":2}
constexpr Vector WRONG_VERSION{
    "7b22657870697265735f6174223a302c2268776964223a223031323334353637383941424344454630313233343536373839414243444546222c226d657373616765223a224c6963656e73652069732076616c6964222c226e6f6e6365223a223030313132323333343435353636373738383939616162626363646465656666222c227365727665725f74696d65223a313736303030303030302c22737461747573223a226f6b222c2276223a327d",
    "28a05580cc20f601d0cbc186dc126cf8690ee38eb9932d301cca325a9ba81c871a4bc207381c626e964ed6af7a7dd925d6ff250696821f16aece7a101ed90f0b"
};

// not json
constexpr Vector NOT_JSON{
    "6e6f74206a736f6e",
    "cfac404139eee8d0f1bba3dba613783c57653e2c2f443d653411ecf93ec8c59b0613d2528f7f1fb7c8f9cf798dcc43c1cadfd4d9507e3fc7ce56db0fbd013b00"
};

[[nodiscard]] Result verify(
    const Vector& vector,
    const std::string_view public_key = PUBLIC_KEY,
    const std::string_view nonce = NONCE,
    const std::string_view hwid = HWID
) {
    return verify_response(vector.payload, vector.signature, public_key, nonce, hwid);
}

[[nodiscard]] Result process(const int http_status, const std::string_view body)
{
    return process_response(http_status, body, PUBLIC_KEY, NONCE, HWID);
}

[[nodiscard]] std::string response_body(const Vector& vector)
{
    return fmt::format(R"({{"payload":"{}","signature":"{}"}})", vector.payload, vector.signature);
}
}

TEST(LicenseTest, HexRoundTrip)
{
    const std::array data{ std::byte{ 0x00 }, std::byte{ 0x01 }, std::byte{ 0x7F }, std::byte{ 0x80 }, std::byte{ 0xAB }, std::byte{ 0xFF } };

    EXPECT_EQ(to_hex(data), "00017f80abff");
    EXPECT_EQ(to_hex(data, true), "00017F80ABFF");

    const auto lower{ from_hex("00017f80abff") };
    ASSERT_TRUE(lower.has_value());
    EXPECT_TRUE(std::ranges::equal(*lower, data));

    const auto upper{ from_hex("00017F80ABFF") };
    ASSERT_TRUE(upper.has_value());
    EXPECT_TRUE(std::ranges::equal(*upper, data));

    EXPECT_EQ(to_hex({}), "");
    ASSERT_TRUE(from_hex("").has_value());
    EXPECT_TRUE(from_hex("")->empty());
}

TEST(LicenseTest, RejectsInvalidHex)
{
    EXPECT_FALSE(from_hex("abc").has_value());
    EXPECT_FALSE(from_hex("zz").has_value());
    EXPECT_FALSE(from_hex("0g").has_value());
    EXPECT_FALSE(from_hex(" 0").has_value());
}

TEST(LicenseTest, Sha256MatchesKnownDigest)
{
    constexpr std::string_view text{ "abc" };
    const auto digest{ sha256(std::as_bytes(std::span{ text })) };

    ASSERT_TRUE(digest.has_value());
    EXPECT_EQ(to_hex(*digest), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
}

TEST(LicenseTest, NormalizesKeys)
{
    EXPECT_EQ(normalize_key("scar-7k3qf-m2x9a-pq4rt-zz81c"), "SCAR-7K3QF-M2X9A-PQ4RT-ZZ81C");
    EXPECT_EQ(normalize_key("  SCAR-7K3QF -\tm2x9a-PQ4RT-zz81c\r\n"), "SCAR-7K3QF-M2X9A-PQ4RT-ZZ81C");
    EXPECT_EQ(normalize_key(" \t\r\n"), "");
}

TEST(LicenseTest, ChecksKeysAreWellFormed)
{
    EXPECT_TRUE(is_well_formed_key("SCAR-7K3QF-M2X9A-PQ4RT-ZZ81C"));
    EXPECT_TRUE(is_well_formed_key("NOT-A-KEY\"\\"));
    EXPECT_TRUE(is_well_formed_key(std::string(MAX_KEY_LENGTH, 'A')));
    EXPECT_FALSE(is_well_formed_key(std::string(MAX_KEY_LENGTH + 1, 'A')));
    EXPECT_FALSE(is_well_formed_key(""));
    EXPECT_FALSE(is_well_formed_key("SCAR-\x01" "AAAA"));
    EXPECT_FALSE(is_well_formed_key("SCAR-\x1b[D"));
    EXPECT_FALSE(is_well_formed_key("SCAR-\x7f"));
    EXPECT_FALSE(is_well_formed_key("SCAR-\xfe\xfd"));  // Code page 1254 bytes, not UTF-8.
    EXPECT_FALSE(is_well_formed_key("SCAR-\xc5\x9e"));  // UTF-8.
}

TEST(LicenseTest, DerivesHwidFromMachineId)
{
    // SHA-256("gtproxy-hwid-v1|0f4c2a9e7d3b4c1aa5e6f7081928374b"), first 16 bytes.
    const auto hwid{ make_hwid("0f4c2a9e7d3b4c1aa5e6f7081928374b") };

    ASSERT_TRUE(hwid.has_value());
    EXPECT_EQ(*hwid, "7D6273B613E57FC964077724A003F7D0");
    EXPECT_EQ(format_hwid(*hwid), "7D6273B6-13E57FC9-64077724-A003F7D0");
    EXPECT_FALSE(make_hwid("").has_value());
}

TEST(LicenseTest, SplitsServerUrl)
{
    using Parts = std::pair<std::string, std::string>;

    EXPECT_EQ(split_server_url("https://keys.example.com"), (Parts{ "https://keys.example.com", "" }));
    EXPECT_EQ(split_server_url("http://127.0.0.1:8080/"), (Parts{ "http://127.0.0.1:8080", "" }));
    EXPECT_EQ(split_server_url("https://example.com/gtproxy/"), (Parts{ "https://example.com", "/gtproxy" }));
}

TEST(LicenseTest, AcceptsValidResponse)
{
    const auto result{ verify(OK) };

    EXPECT_EQ(result.status, Status::Ok);
    EXPECT_EQ(result.expires_at, 1800000000);
    EXPECT_EQ(result.server_time, SERVER_TIME);
    EXPECT_EQ(result.message, "License is valid");
}

TEST(LicenseTest, AcceptsLifetimeLicense)
{
    const auto result{ verify(OK_LIFETIME) };

    EXPECT_EQ(result.status, Status::Ok);
    EXPECT_EQ(result.expires_at, 0);
}

TEST(LicenseTest, MapsEachStatus)
{
    EXPECT_EQ(verify(INVALID_KEY).status, Status::InvalidKey);
    EXPECT_EQ(verify(REVOKED).status, Status::Revoked);
    EXPECT_EQ(verify(EXPIRED).status, Status::Expired);
    EXPECT_EQ(verify(HWID_MISMATCH).status, Status::HwidMismatch);
    EXPECT_EQ(verify(INVALID_KEY).message, "Unknown license key");
    EXPECT_EQ(verify(HWID_MISMATCH).message, "License key is bound to another computer");
}

TEST(LicenseTest, TreatsOkAtServerExpiryAsExpired)
{
    const auto result{ verify(OK_EXPIRES_NOW) };

    EXPECT_EQ(result.status, Status::Expired);
    EXPECT_EQ(result.message, describe(Status::Expired));
}

TEST(LicenseTest, ComparesHwidCaseInsensitively)
{
    EXPECT_EQ(verify(OK_LOWERCASE_HWID).status, Status::Ok);
    EXPECT_EQ(verify(OK, PUBLIC_KEY, NONCE, "0123456789abcdef0123456789abcdef").status, Status::Ok);
}

TEST(LicenseTest, RejectsWrongNonce)
{
    EXPECT_EQ(verify(OK, PUBLIC_KEY, "ffeeddccbbaa99887766554433221100").status, Status::BadResponse);
}

TEST(LicenseTest, RejectsWrongHwid)
{
    EXPECT_EQ(verify(OK, PUBLIC_KEY, NONCE, "FEDCBA9876543210FEDCBA9876543210").status, Status::BadResponse);
}

TEST(LicenseTest, RejectsTamperedPayload)
{
    const auto bytes{ from_hex(OK.payload) };
    ASSERT_TRUE(bytes.has_value());

    std::string json{ reinterpret_cast<const char*>(bytes->data()), bytes->size() };
    const auto pos{ json.find("1800000000") };
    ASSERT_NE(pos, std::string::npos);
    json.replace(pos, 10, "1900000000");

    const auto tampered{ to_hex(std::as_bytes(std::span{ json })) };
    EXPECT_EQ(verify_response(tampered, OK.signature, PUBLIC_KEY, NONCE, HWID).status, Status::BadSignature);
}

TEST(LicenseTest, RejectsTamperedSignature)
{
    std::string signature{ OK.signature };
    signature[0] = signature[0] == '0' ? '1' : '0';

    EXPECT_EQ(verify_response(OK.payload, signature, PUBLIC_KEY, NONCE, HWID).status, Status::BadSignature);
    EXPECT_EQ(verify_response(OK.payload, OK_LIFETIME.signature, PUBLIC_KEY, NONCE, HWID).status, Status::BadSignature);
    EXPECT_EQ(verify_response(OK.payload, OK.signature.substr(0, 126), PUBLIC_KEY, NONCE, HWID).status, Status::BadSignature);
}

TEST(LicenseTest, RejectsWrongPublicKey)
{
    EXPECT_EQ(verify(OK, OTHER_PUBLIC_KEY).status, Status::BadSignature);
    EXPECT_EQ(verify(OK, PUBLIC_KEY.substr(0, 62)).status, Status::BadSignature);
    EXPECT_EQ(verify(OK, "").status, Status::BadSignature);
}

TEST(LicenseTest, RejectsMalformedSignedPayload)
{
    EXPECT_EQ(verify(NOT_JSON).status, Status::BadResponse);
    EXPECT_EQ(verify(WRONG_VERSION).status, Status::BadResponse);
    EXPECT_EQ(verify(UNKNOWN_STATUS).status, Status::BadResponse);
}

TEST(LicenseTest, RejectsNonHexFields)
{
    EXPECT_EQ(verify_response("zz", OK.signature, PUBLIC_KEY, NONCE, HWID).status, Status::ServerError);
    EXPECT_EQ(verify_response("", OK.signature, PUBLIC_KEY, NONCE, HWID).status, Status::ServerError);
    EXPECT_EQ(verify_response(OK.payload, "xyz", PUBLIC_KEY, NONCE, HWID).status, Status::ServerError);
}

TEST(LicenseTest, ProcessesHttpResponse)
{
    const auto result{ process(200, response_body(OK)) };
    EXPECT_EQ(result.status, Status::Ok);
    EXPECT_EQ(result.expires_at, 1800000000);

    EXPECT_EQ(process(200, response_body(REVOKED)).status, Status::Revoked);
}

TEST(LicenseTest, ReportsServerErrors)
{
    const auto bad_request{ process(400, R"({"error":"invalid hwid"})") };
    EXPECT_EQ(bad_request.status, Status::ServerError);
    EXPECT_EQ(bad_request.message, "License server error (HTTP 400): invalid hwid");

    const auto escaped{ process(400, R"({"error":"bad\u001b[31m input"})") };
    EXPECT_EQ(escaped.message, "License server error (HTTP 400): bad[31m input");

    EXPECT_EQ(process(500, "Internal Server Error").status, Status::ServerError);
    EXPECT_EQ(process(404, "").status, Status::ServerError);
    EXPECT_EQ(process(200, "not json").status, Status::ServerError);
    EXPECT_EQ(process(200, R"({"payload":"00"})").status, Status::ServerError);
    EXPECT_EQ(process(200, R"({"payload":"zz","signature":"00"})").status, Status::ServerError);
}

TEST(LicenseTest, ClassifiesRejections)
{
    EXPECT_TRUE(is_rejection(Status::InvalidKey));
    EXPECT_TRUE(is_rejection(Status::Revoked));
    EXPECT_TRUE(is_rejection(Status::Expired));
    EXPECT_TRUE(is_rejection(Status::HwidMismatch));

    EXPECT_FALSE(is_rejection(Status::Ok));
    EXPECT_FALSE(is_rejection(Status::BadSignature));
    EXPECT_FALSE(is_rejection(Status::BadResponse));
    EXPECT_FALSE(is_rejection(Status::ServerError));
    EXPECT_FALSE(is_rejection(Status::NetworkError));
}
