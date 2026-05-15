from profile import load_user_profile


class ResourceWorker:
    def sync_resources(self, email: str):
        return load_user_profile(email)


def run_worker():
    worker = ResourceWorker()
    return worker.sync_resources("person@example.com")
