package org.multipaz.mpzpass

// Throwaway jvmTest: mint the CredentAgent demo credential set as .mpzpass files a
// REAL Multipaz Wallet can hold, each SIGNED BY THE OpenSSL demo Document Signer
// (tools/demo-pki/certs/ds-cert.pem + keys/ds-key.pem) rather than the harness's
// self-signed DS. Generalizes ProfessionalLicenseMintTest.kt to the full set:
//   mDL           org.iso.18013.5.1.mDL  (age_over_18/21/65 = true — 65+ persona)
//   loyalty       org.multipaz.loyalty.1 (membership_number + tier)
//   payment (sca) org.multipaz.payment.sca.1 (issuer-signed instrument claims)
//   pro license   org.example.license.1  (license_active = true)
// Doctypes/namespaces/claims match what the credentagent-gate DCQL requests.
//
// This file is a COPY of tools/demo-pki/mint/DemoCredentialMintTest.kt placed here
// so it compiles against the multipaz module. Run:
//   cd ~/tools/git/multipaz && ./gradlew :multipaz:jvmTest \
//       --tests "org.multipaz.mpzpass.DemoCredentialMintTest" --rerun-tasks

import kotlinx.coroutines.test.runTest
import kotlinx.datetime.LocalDate
import kotlinx.io.bytestring.ByteString
import org.multipaz.cbor.Cbor
import org.multipaz.cbor.DataItem
import org.multipaz.cbor.toDataItem
import org.multipaz.cbor.toDataItemFullDate
import org.multipaz.crypto.AsymmetricKey
import org.multipaz.crypto.EcPrivateKey
import org.multipaz.crypto.X509Cert
import org.multipaz.crypto.X509CertChain
import org.multipaz.documenttype.DocumentAttributeType as Attr
import org.multipaz.documenttype.DocumentType
import org.multipaz.presentment.DocumentStoreTestHarness
import org.multipaz.securearea.CreateKeySettings
import java.io.File
import kotlin.test.Test

class DemoCredentialMintTest {

    private val DEMO_PKI = "/Users/diegozuluaga/tools/git/attestomcp-demo-pki/tools/demo-pki"
    private val CERTS = "$DEMO_PKI/certs"
    private val KEYS = "$DEMO_PKI/keys"
    private val CARDART = "$DEMO_PKI/cardart"
    private val OUT = "$DEMO_PKI/out"

    // ---- terse attribute helper (id doubles as display/description for a demo) ----
    private fun DocumentType.Builder.attr(
        type: Attr, id: String, ns: String, sample: DataItem, mandatory: Boolean = true
    ) = addMdocAttribute(
        type = type, identifier = id, displayName = id, description = id,
        mandatory = mandatory, mdocNamespace = ns, sampleValue = sample
    )

    // ---- the four demo DocumentTypes ----
    private val MDL_NS = "org.iso.18013.5.1"
    private fun mdlType() = DocumentType.Builder("Driver License")
        .addMdocDocumentType("org.iso.18013.5.1.mDL")
        .attr(Attr.String, "family_name", MDL_NS, "Appleseed".toDataItem())
        .attr(Attr.String, "given_name", MDL_NS, "Jo".toDataItem())
        .attr(Attr.Date, "birth_date", MDL_NS, LocalDate.parse("1955-05-04").toDataItemFullDate())
        .attr(Attr.Date, "issue_date", MDL_NS, LocalDate.parse("2024-01-01").toDataItemFullDate())
        .attr(Attr.Date, "expiry_date", MDL_NS, LocalDate.parse("2030-01-01").toDataItemFullDate())
        .attr(Attr.String, "issuing_country", MDL_NS, "US".toDataItem())
        .attr(Attr.String, "issuing_authority", MDL_NS, "Utopia Demo DMV".toDataItem())
        .attr(Attr.String, "document_number", MDL_NS, "DEMO-000065".toDataItem())
        .attr(Attr.String, "un_distinguishing_sign", MDL_NS, "USA".toDataItem())
        .attr(Attr.Boolean, "age_over_18", MDL_NS, true.toDataItem(), mandatory = false)
        .attr(Attr.Boolean, "age_over_21", MDL_NS, true.toDataItem(), mandatory = false)
        .attr(Attr.Boolean, "age_over_65", MDL_NS, true.toDataItem(), mandatory = false)
        .build()

    private fun loyaltyType() = DocumentType.Builder("Membership")
        .addMdocDocumentType("org.multipaz.loyalty.1")
        .attr(Attr.String, "membership_number", "org.multipaz.loyalty.1", "UTOPIA-000007".toDataItem())
        .attr(Attr.String, "tier", "org.multipaz.loyalty.1", "Gold".toDataItem(), mandatory = false)
        .build()

    private val PAY_NS = "org.multipaz.payment.sca.1"
    private fun paymentType() = DocumentType.Builder("Digital Payment")
        .addMdocDocumentType("org.multipaz.payment.sca.1")
        .attr(Attr.String, "issuer_name", PAY_NS, "Utopia Demo Bank".toDataItem())
        .attr(Attr.String, "payment_instrument_id", PAY_NS, "demo-instrument-0001".toDataItem())
        .attr(Attr.String, "masked_account_reference", PAY_NS, "**** 4242".toDataItem())
        .attr(Attr.String, "holder_name", PAY_NS, "Jo Appleseed".toDataItem())
        .attr(Attr.Date, "issue_date", PAY_NS, LocalDate.parse("2024-01-01").toDataItemFullDate())
        .attr(Attr.Date, "expiry_date", PAY_NS, LocalDate.parse("2030-01-01").toDataItemFullDate())
        .build()

    private fun proLicenseType() = DocumentType.Builder("Professional License")
        .addMdocDocumentType("org.example.license.1")
        .attr(Attr.Boolean, "license_active", "org.example.license.1", true.toDataItem())
        .build()

    private suspend fun mintOne(
        harness: DocumentStoreTestHarness,
        docType: DocumentType,
        displayName: String,
        typeDisplayName: String,
        cardArtFile: String,
        outFile: String,
    ) {
        val cardArt = File("$CARDART/$cardArtFile").readBytes()
        val doc = harness.documentStore.createDocument(
            displayName = displayName,
            typeDisplayName = typeDisplayName,
            cardArt = ByteString(cardArt),
        )
        val credential = docType.createMdocCredentialWithSampleData(
            document = doc,
            secureArea = harness.softwareSecureArea,
            createKeySettings = CreateKeySettings(),
            dsKey = harness.dsKey,                 // overridden below to the OpenSSL DS
            signedAt = harness.signedAt,           // now-1d, inside the DS cert window
            validFrom = harness.validFrom,         // now-1d
            validUntil = harness.validUntil,       // now+365d, inside the 455d DS window
            expectedUpdate = null,
            domain = "mdoc",
        )
        doc.edit { provisioned = true }
        val pass = credential.exportToMpzPass()
        val out = File("$OUT/$outFile")
        out.parentFile.mkdirs()
        out.writeBytes(Cbor.encode(pass.toDataItem()))
        println("MINTED $outFile -> ${out.absolutePath} (${out.length()} bytes)")
    }

    @Test
    fun mintAll() = runTest {
        val harness = DocumentStoreTestHarness()
        harness.initialize()

        // Replace the harness's self-signed DS with the OpenSSL demo Document Signer,
        // so every credential's MSO is signed by a key that chains to the demo IACA
        // (which the VICAL will publish as a trust anchor). x5chain carries DS + IACA.
        val dsCert = X509Cert.fromPem(File("$CERTS/ds-cert.pem").readText())
        val iacaCert = X509Cert.fromPem(File("$CERTS/iaca-cert.pem").readText())
        val dsPriv = EcPrivateKey.fromPem(File("$KEYS/ds-key.pem").readText(), dsCert.ecPublicKey)
        harness.dsKey = AsymmetricKey.X509CertifiedExplicit(
            X509CertChain(listOf(dsCert, iacaCert)), dsPriv
        )
        println("Using DS subject: ${dsCert.subject.name}")

        mintOne(harness, mdlType(), "Utopia Driver License", "Driver License",
            "card-mdl.png", "mdl.mpzpass")
        mintOne(harness, loyaltyType(), "Utopia Membership", "Loyalty membership",
            "card-membership.png", "membership.mpzpass")
        mintOne(harness, paymentType(), "Utopia Digital Payment", "Payment instrument",
            "card-payment.png", "payment.mpzpass")
        mintOne(harness, proLicenseType(), "Utopia Professional License", "Licensed trade",
            "card-professional.png", "professional-license.mpzpass")

        println("DONE minting demo credential set into $OUT")
    }
}
