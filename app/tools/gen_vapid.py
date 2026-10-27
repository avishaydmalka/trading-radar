"""Generate VAPID keys for web push. Usage: python -m app.tools.gen_vapid"""
import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def main() -> None:
    key = ec.generate_private_key(ec.SECP256R1())
    priv = key.private_numbers().private_value.to_bytes(32, "big")
    pub = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    print("# העתק את שתי השורות לקובץ .env")
    print(f"VAPID_PUBLIC_KEY={b64(pub)}")
    print(f"VAPID_PRIVATE_KEY={b64(priv)}")


if __name__ == "__main__":
    main()
