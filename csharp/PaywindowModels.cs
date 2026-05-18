// ============================================================
// DTOs fuer die Paywindow-Lookup-API.
//
// Das Paywindow-Frontend ruft den Node-Bridge-Server unter
//   POST /api/build-mint   { id, buyerShieldedAddress }
// auf. Der Bridge-Server holt zur "id" das hier definierte
// PaywindowData-Objekt vom NMKR Studio:
//   GET {NMKR_STUDIO_URL}/paywindow/{id}
//
// Achtung: OwnerSeed ist hochsensibel. Dieses Objekt darf das
// NMKR-Studio-Backend NIEMALS an den Browser geben — nur an den
// (auth'd) Paywindow-Bridge-Server.
// ============================================================

using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Nmkr.Midnight.Paywindow.Models;

/// <summary>
/// Alles, was die Paywindow-Bridge zu einer Paywindow-Id braucht,
/// um eine atomare Mint-Tx auf Midnight zu bauen.
/// </summary>
public class PaywindowData
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    /// <summary>
    /// Collection-Owner-Seed (32-Byte hex oder Mnemonic — je nachdem wie
    /// nmkr-midnight-api das erwartet). Wird zum Signieren der Mint-Tx benoetigt.
    /// MUSS server-seitig bleiben — niemals zum Browser durchreichen.
    /// </summary>
    [JsonPropertyName("ownerSeed")]
    public string OwnerSeed { get; set; } = "";

    /// <summary>
    /// Bech32m-Adresse des deployten NFT-Contracts, in den geminted wird.
    /// </summary>
    [JsonPropertyName("contractAddress")]
    public string ContractAddress { get; set; } = "";

    [JsonPropertyName("nft")]
    public PaywindowNft Nft { get; set; } = new();

    /// <summary>
    /// Optional. Wenn gesetzt, werden in derselben Tx NIGHT-Outputs
    /// an die Empfaenger angehaengt (Buy &amp; Mint atomar).
    /// </summary>
    [JsonPropertyName("payment")]
    public PaywindowPayment? Payment { get; set; }
}

public class PaywindowNft
{
    /// <summary>Anzeigename des NFT — beim Reveal sichtbar.</summary>
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    /// <summary>URI/Link zu den ausfuehrlichen Metadaten (off-chain).</summary>
    [JsonPropertyName("uri")]
    public string Uri { get; set; } = "";

    /// <summary>Image-URL (https oder ipfs).</summary>
    [JsonPropertyName("image")]
    public string Image { get; set; } = "";

    /// <summary>MIME-Typ des Image, z.B. "image/png" oder "image/svg+xml".</summary>
    [JsonPropertyName("mediaType")]
    public string MediaType { get; set; } = "";

    /// <summary>Beschreibung — erst nach erfolgreichem Mint sichtbar.</summary>
    [JsonPropertyName("description")]
    public string Description { get; set; } = "";

    /// <summary>
    /// Beliebige zusaetzliche Metadaten (rarity, edition, properties, …).
    /// Werden beim Reveal-Klick angezeigt.
    /// </summary>
    [JsonPropertyName("attributes")]
    public Dictionary<string, object>? Attributes { get; set; }
}

public class PaywindowPayment
{
    /// <summary>Gesamtpreis in NIGHT (nur Anzeige; tatsaechliche Verteilung steckt in Recipients).</summary>
    [JsonPropertyName("priceNight")]
    public decimal PriceNight { get; set; }

    [JsonPropertyName("recipients")]
    public List<PaywindowRecipient> Recipients { get; set; } = new();
}

public class PaywindowRecipient
{
    /// <summary>Bech32m unshielded NIGHT-Empfaengeradresse.</summary>
    [JsonPropertyName("address")]
    public string Address { get; set; } = "";

    /// <summary>Betrag in atomaren NIGHT-Units (1 NIGHT = 1_000_000), als String wegen BigInt-Kompatibilitaet.</summary>
    [JsonPropertyName("amountRaw")]
    public string AmountRaw { get; set; } = "";
}
