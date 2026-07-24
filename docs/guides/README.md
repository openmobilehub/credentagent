# Guides

Task-oriented how-tos, in the order you'll hit them. They build on the zero-config
quickstart — start there, then level up only if you need to.

1. **[Getting started](../reference/getting-started.md)** *(reference)* — stand up a
   credential-gated storefront in ~10 lines and drive it from an MCP host. No wallet,
   no PKI. This is the whole first-run experience.
2. **[Trusted demo credentials](trusted-demo-credentials.md)** — get credentials a real
   phone wallet *trusts* (clears the red "untrusted issuer" warning), so you can complete
   a gate on-device instead of just reading about it. This is the demo PKI.
3. **[Testing on a device](testing-on-device.md)** — import those credentials into the
   Multipaz wallet and run a full ceremony against your local gate over `adb`.

**Where the rest lives:** the *why* (trust levels, `presence-only-demo` →
`issuer-verified`) is in [`reference/trust-model.md`](../reference/trust-model.md); the
credential-minting *toolchain* is in [`tools/demo-pki/`](../../tools/demo-pki/README.md).

> **For agents:** the demo-credential build pipeline is being packaged as a runnable
> `demo-pki` skill (tracked in
> [#53](https://github.com/openmobilehub/credentagent/issues/53)) so an agent can
> regenerate the set in one step. Until it lands, follow
> [`tools/demo-pki/README.md`](../../tools/demo-pki/README.md).
