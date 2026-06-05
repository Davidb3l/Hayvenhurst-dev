//! Tiny fixture used by parse_rust integration tests.

pub struct Greeter {
    pub prefix: String,
}

impl Greeter {
    pub fn new(prefix: &str) -> Self {
        Self {
            prefix: prefix.to_string(),
        }
    }

    pub fn hello(&self, name: &str) -> String {
        format!("{} {}", self.prefix, name)
    }

    pub fn shout(&self, name: &str) -> String {
        self.hello(name).to_uppercase()
    }
}

pub fn greet(name: &str) -> String {
    format!("hello {}", name)
}

pub fn run() -> String {
    let g = Greeter::new("hi");
    g.shout("world")
}
