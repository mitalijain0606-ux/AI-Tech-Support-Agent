from pydantic import BaseModel


class ConsoleEvidence(BaseModel):
    pass


class NetworkEvidence(BaseModel):
    pass


class CookieSignal(BaseModel):
    pass


class StorageSignal(BaseModel):
    pass


class EvidenceBundle(BaseModel):
    pass


class DiagnoseRequest(BaseModel):
    pass


class ProposedAction(BaseModel):
    pass


class Diagnosis(BaseModel):
    pass


class PolicyRequest(BaseModel):
    pass


class PolicyDecision(BaseModel):
    pass
