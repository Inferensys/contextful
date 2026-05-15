pub struct ResourcePolicy {
    pub name: String,
}

pub fn evaluate_policy(policy: ResourcePolicy) -> bool {
    !policy.name.is_empty()
}
