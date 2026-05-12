#[cfg(not(target_arch = "wasm32"))]
fn main() {
    use cosmwasm_schema::write_api;
    use choice_token_locker::msg::{ExecuteMsg, InstantiateMsg, MigrateMsg, QueryMsg};

    write_api! {
        instantiate: InstantiateMsg,
        execute: ExecuteMsg,
        query: QueryMsg,
        migrate: MigrateMsg,
    }
}

#[cfg(target_arch = "wasm32")]
fn main() {}
