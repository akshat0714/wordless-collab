"""Read-only, streaming support export adapters.

All adapters normalize vendor records to the canonical models and redact every
interaction before it leaves the adapter boundary.  This package deliberately
contains no customer-system clients or mutation APIs.
"""

from .base import Adapter, AdapterError, IngestSummary
from .chatwoot import ChatwootAdapter
from .generic import GenericAdapter, MappingError
from .intercom import IntercomAdapter
from .mendeley_public import MendeleyHelpdeskV2Adapter, MendeleyPublicAdapter
from .state_bench import StateBenchCustomerSupportAdapter
from .zammad import ZammadAdapter
from .zendesk import ZendeskAdapter

ADAPTER_TYPES: tuple[type[Adapter], ...] = (
    ZendeskAdapter,
    IntercomAdapter,
    ChatwootAdapter,
    ZammadAdapter,
    GenericAdapter,
)

__all__ = [
    "ADAPTER_TYPES",
    "Adapter",
    "AdapterError",
    "ChatwootAdapter",
    "GenericAdapter",
    "IngestSummary",
    "IntercomAdapter",
    "MappingError",
    "MendeleyHelpdeskV2Adapter",
    "MendeleyPublicAdapter",
    "StateBenchCustomerSupportAdapter",
    "ZammadAdapter",
    "ZendeskAdapter",
]
