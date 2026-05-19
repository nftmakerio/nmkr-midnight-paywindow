// ============================================================
// DTOs for the paywindow lookup API.
//
// The paywindow frontend calls the Node bridge at
//   POST /api/build-mint   { id, buyerShieldedAddress }
// The bridge in turn fetches the PaywindowData record for that id
// from NMKR Studio:
//   GET {NMKR_STUDIO_URL}/paywindow/{id}
//
// SECURITY: OwnerSeed is highly sensitive. The NMKR Studio backend
// must NEVER expose this object to a browser — only to the
// authenticated paywindow bridge server.
// ============================================================

using System.Collections.Generic;
using System.Text.Json.Serialization;

// Note: rich per-NFT attributes (rarity, edition, properties, …) belong
// in the off-chain metadata JSON pointed to by Nft.Uri. The paywindow
// reveal shows the URI as a link so the user can inspect them.

namespace Nmkr.Midnight.Paywindow.Models;

/// <summary>
/// Everything the paywindow bridge needs for a given paywindow id
/// in order to build an atomic mint transaction on Midnight.
/// </summary>
public class PaywindowData
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    /// <summary>
    /// Collection owner seed (32-byte hex or mnemonic, whichever
    /// nmkr-midnight-api expects). Used to sign the mint transaction.
    /// MUST stay server-side — never forward this to the browser.
    /// </summary>
    [JsonPropertyName("ownerSeed")]
    public string OwnerSeed { get; set; } = "";

    /// <summary>
    /// Bech32m address of the deployed NFT contract to mint into.
    /// </summary>
    [JsonPropertyName("contractAddress")]
    public string ContractAddress { get; set; } = "";

    [JsonPropertyName("nft")]
    public PaywindowNft Nft { get; set; } = new();

    /// <summary>
    /// Optional. When set and non-empty, NIGHT outputs to the listed
    /// recipients are appended to the same transaction (atomic buy &amp; mint).
    /// Omit or send an empty list for a free mint.
    /// </summary>
    [JsonPropertyName("recipients")]
    public List<PaywindowRecipient>? Recipients { get; set; }
}

/// <summary>One NIGHT payment output included in the mint transaction.</summary>
/// <param name="Address">Bech32m unshielded NIGHT recipient address.</param>
/// <param name="AmountRaw">Amount in atomic NIGHT units (1 NIGHT = 1_000_000) as a string (BigInt-safe).</param>
public record PaywindowRecipient(
    [property: JsonPropertyName("address")]   string Address,
    [property: JsonPropertyName("amountRaw")] string AmountRaw);

public class PaywindowNft
{
    /// <summary>Display name of the NFT — shown after the reveal.</summary>
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    /// <summary>URI / link to the full off-chain metadata.</summary>
    [JsonPropertyName("uri")]
    public string Uri { get; set; } = "";

    /// <summary>Image URL (https or ipfs).</summary>
    [JsonPropertyName("image")]
    public string Image { get; set; } = "";

    /// <summary>Image MIME type, e.g. "image/png" or "image/svg+xml".</summary>
    [JsonPropertyName("mediaType")]
    public string MediaType { get; set; } = "";

    /// <summary>Description — revealed only after a successful mint.</summary>
    [JsonPropertyName("description")]
    public string Description { get; set; } = "";
}

